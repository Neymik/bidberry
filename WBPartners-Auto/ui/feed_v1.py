"""WB Partners 2.31.x UI ("Лента заказов" on the home dashboard, sorted by order date).

Moved verbatim from open_feed.py + backfill_range.py — v1 behavior is frozen here
while feed_v2 handles the 2.34+ layout. Pure ADB (uiautomator dump + input), no
uiautomator2, so it is safe to run from a dev machine against an emulator.
"""

import re
import subprocess
import sys
import time
from datetime import datetime
from xml.etree import ElementTree

from db import build_key, get_all_keys, init_db, parse_russian_date, upsert_order

REQUIRED_FIELDS = ("article", "status", "date", "price")
DUMP_PATH = "/sdcard/wb_backfill_dump.xml"


def make_adb(serial):
    def adb(*args):
        cmd = ["adb"]
        if serial:
            cmd += ["-s", serial]
        cmd += list(args)
        return subprocess.run(cmd, capture_output=True)
    return adb


# ---------------------------------------------------------------------------
# Navigation (from open_feed.py): relaunch app -> dismiss popups -> scroll the
# dashboard to the 'Лента заказов' section -> tap its 'Ещё' -> verify feed open.
# ---------------------------------------------------------------------------

def _dump_nav(adb):
    adb("shell", "uiautomator", "dump", "/sdcard/nav.xml")
    return adb("exec-out", "cat", "/sdcard/nav.xml").stdout.decode("utf-8", "replace")


def _nodes(xml):
    out = []
    for n in ElementTree.fromstring(xml).iter():
        b = n.get("bounds")
        if not b:
            continue
        x1, y1, x2, y2 = map(int, re.findall(r"\d+", b))
        out.append({
            "text": (n.get("text") or "").strip(),
            "desc": (n.get("content-desc") or "").strip(),
            "rid": n.get("resource-id") or "",
            "clk": n.get("clickable") == "true",
            "cx": (x1 + x2) // 2, "cy": (y1 + y2) // 2,
        })
    return out


def _find(ns, *, text=None, contains=None, rid=None):
    for n in ns:
        lbl = n["text"] + " " + n["desc"]
        if text and n["text"] == text:
            return n
        if contains and contains.lower() in lbl.lower():
            return n
        if rid and rid in n["rid"]:
            return n
    return None


def _tap(adb, n):
    adb("shell", "input", "tap", str(n["cx"]), str(n["cy"]))
    time.sleep(1.5)


def _on_feed(ns):
    return _find(ns, text="Лента заказов") and _find(ns, text="Все") and _find(ns, text="Выкупы")


def open_feed(serial):
    """Navigate to the 'Лента заказов' feed, parked at the top. Returns 0 on success."""
    adb = make_adb(serial)
    adb("shell", "am", "force-stop", "wb.partners")
    time.sleep(1)
    adb("shell", "monkey", "-p", "wb.partners", "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(8)  # splash + load

    # Dismiss any stacked popups (promo bottom sheet, "update app" dialog).
    for _ in range(6):
        ns = _nodes(_dump_nav(adb))
        if _on_feed(ns):
            print("Feed already open")
            return 0
        later = _find(ns, text="Не сейчас")
        x = _find(ns, contains="Xmark") or _find(ns, contains="CloseSheet")
        if later:
            print("  dismissing update dialog"); _tap(adb, later); continue
        if x:
            print("  closing promo sheet"); _tap(adb, x); continue
        break

    # Scroll the dashboard down to reveal the 'Лента заказов' section, then tap 'Ещё'.
    for i in range(8):
        ns = _nodes(_dump_nav(adb))
        lenta = _find(ns, text="Лента заказов")
        if lenta:
            more = None
            for n in ns:
                if n["text"] == "Ещё" and abs(n["cy"] - lenta["cy"]) < 90:
                    more = n
                    break
            if more:
                print(f"  tapping 'Ещё' next to Лента заказов at ({more['cx']},{more['cy']})")
                _tap(adb, more)
                break
            print("  Лента заказов found but no adjacent 'Ещё' — tapping the section title")
            _tap(adb, lenta)
            break
        adb("shell", "input", "swipe", "540", "1700", "540", "650", "300")
        time.sleep(1.2)

    # Verify
    for _ in range(5):
        ns = _nodes(_dump_nav(adb))
        if _on_feed(ns):
            print("Opened Лента заказов (feed at top)")
            return 0
        time.sleep(1.5)
    print("ERROR: could not confirm feed open", file=sys.stderr)
    return 2


# ---------------------------------------------------------------------------
# Backfill (from backfill_range.py): scroll the feed newest->oldest collecting
# orders until the oldest visible card crosses the --since cutoff.
# ---------------------------------------------------------------------------

def dump_xml(adb, retries=5):
    """Dump the UI hierarchy, retrying transient empty/invalid dumps.

    uiautomator occasionally returns an empty file ("null root node") right after
    a screen transition or a fresh boot; a single such hiccup must not abort a
    long backfill, so retry a few times before giving up.
    """
    xml = ""
    for _ in range(retries):
        adb("shell", "uiautomator", "dump", DUMP_PATH)
        out = adb("exec-out", "cat", DUMP_PATH).stdout
        xml = out.decode("utf-8", "replace").strip()
        if xml.startswith("<?xml") or xml.startswith("<hierarchy"):
            return xml
        time.sleep(0.7)
    return xml


def screen_size(adb):
    out = adb("shell", "wm", "size").stdout.decode("utf-8", "replace")
    m = re.search(r"(\d+)x(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else (1080, 2400)


def swipe(adb, x1, y1, x2, y2, dur=300):
    adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(dur))


def parse_orders(xml_str):
    """Parse all visible order cards from a Лента заказов UI dump.

    Faithful to wb_order_monitor.parse_orders_from_hierarchy, with one addition:
    the real "Статус" badge value is captured (the live monitor hardcodes "Заказ"
    because it sees orders the instant they land; for a past-days backfill the badge
    already reflects the final outcome — Заказ / Выкуп / Отказ / Возврат).
    """
    if not xml_str.strip() or "Что-то пошло не так" in xml_str:
        return []

    root = ElementTree.fromstring(xml_str)

    scrollable = None
    for node in root.iter():
        if node.get("scrollable") == "true" and node.get("package") == "wb.partners":
            scrollable = node
            break
    if scrollable is None:
        return []

    orders = []
    for card in scrollable:
        texts = [n.get("text", "").strip() for n in card.iter() if n.get("text", "").strip()]
        if len(texts) < 4:
            continue

        order = {}
        product = texts[0]
        if product.isdigit() or product in ("Дата оформления", "Стоимость", "Прибытие", "Склад WB", "Статус"):
            product = ""
        order["product"] = product
        order["status"] = "Заказ"  # default; overridden by the Статус badge below

        for i, text in enumerate(texts):
            nxt = texts[i + 1] if i + 1 < len(texts) else None
            if text.isdigit() and len(text) > 5:
                order["article"] = text
                if nxt and not nxt.isdigit() and not nxt.startswith("Размер") and "шт" not in nxt:
                    order["vendor_code"] = nxt
            elif text.startswith("Размер"):
                order["size"] = text.replace("Размер ", "")
            elif "шт" in text and len(text) < 10:
                order["quantity"] = text
            elif "₽" in text:
                order["price"] = text
            elif text == "Статус" and nxt:
                order["status"] = nxt
            elif text == "Дата оформления" and nxt:
                order["date"] = nxt
            elif text == "Прибытие" and nxt:
                order["arrival_city"] = nxt
            elif text == "Склад WB" and nxt:
                order["warehouse"] = nxt

        if not order.get("date"):
            for text in texts:
                if ":" in text and any(m in text for m in
                    ["янв", "фев", "мар", "апр", "май", "июн",
                     "июл", "авг", "сен", "окт", "ноя", "дек"]):
                    order["date"] = text
                    break

        if any(not order.get(f) for f in REQUIRED_FIELDS):
            continue

        order["key"] = build_key(order)
        orders.append(order)
    return orders


def top_card_key(adb):
    orders = parse_orders(dump_xml(adb))
    return orders[0]["key"] if orders else None


def scroll_to_top(adb, w, h, max_flings=120):
    """Fling toward the top of the feed until the top card stops changing.

    The feed may be parked anywhere (e.g. at the bottom after a deep backfill),
    so a fixed number of swipes is not enough — fling until stable.
    """
    last = None
    stable = 0
    for i in range(max_flings):
        # Finger top->bottom scrolls content down, revealing newer (top) cards.
        swipe(adb, w // 2, int(h * 0.25), w // 2, int(h * 0.90), 120)
        time.sleep(0.5)
        cur = top_card_key(adb)
        if cur is not None and cur == last:
            stable += 1
            if stable >= 3:
                print(f"  Reached top after {i + 1} flings")
                return
        else:
            stable = 0
        last = cur
    print(f"  scroll_to_top: hit fling cap ({max_flings}) — proceeding from current position")


def run(serial, since_str, max_scrolls, scroll_pause, skip_top=False, stop_on_known=False):
    cutoff = datetime.strptime(since_str, "%Y-%m-%d")
    adb = make_adb(serial)
    init_db()

    w, h = screen_size(adb)
    print(f"Device {serial or '(default)'}  screen {w}x{h}  cutoff {cutoff}  "
          f"skip_top={skip_top}  stop_on_known={stop_on_known}")

    known = get_all_keys() if stop_on_known else set()
    if stop_on_known:
        print(f"  Loaded {len(known)} known keys — will stop at the first already-seen order")

    if not skip_top:
        scroll_to_top(adb, w, h)
        time.sleep(1)

    collected = {}  # key -> order (newest-first discovery order)
    no_progress = 0
    reached_cutoff = False
    known_streak = 0
    new = dup = 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for scroll_i in range(max_scrolls + 1):
        orders = parse_orders(dump_xml(adb))
        oldest = None
        added = 0
        saw_known = False
        for o in orders:
            if o["key"] in known:
                saw_known = True
            d = parse_russian_date(o.get("date", ""), year=cutoff.year)
            if d and (oldest is None or d < oldest):
                oldest = d
            if d and d >= cutoff and o["key"] not in collected:
                collected[o["key"]] = o
                added += 1
                # Persist immediately so a mid-scroll kill never loses progress
                # (the feed is long; these runs can be terminated externally).
                o["first_seen"] = now_str
                if upsert_order(o):
                    new += 1
                else:
                    dup += 1

        # Boundary: we've scrolled into already-scraped territory. Require two
        # consecutive dumps with a known card (the overlap swipe shows each card
        # twice) so a single stray match can't stop us early.
        if stop_on_known and saw_known:
            known_streak += 1
            if known_streak >= 2:
                print(f"  Reached known-order boundary at scroll {scroll_i} ({len(collected)} new)")
                break
        else:
            known_streak = 0

        if oldest is not None and oldest < cutoff:
            reached_cutoff = True
            print(f"  Reached cutoff at scroll {scroll_i} (oldest visible {oldest}, {len(collected)} collected)")
            break

        if added == 0:
            no_progress += 1
            if no_progress >= 4:
                print(f"  Stopping: {no_progress} scrolls with no new in-range cards "
                      f"(oldest visible {oldest})")
                break
        else:
            no_progress = 0

        if scroll_i and scroll_i % 10 == 0:
            print(f"  ... scroll {scroll_i}, {len(collected)} collected (oldest {oldest})")

        # Overlap swipe (~30% of screen) so each card appears in two consecutive dumps.
        swipe(adb, w // 2, int(h * 0.70), w // 2, int(h * 0.40), 300)
        time.sleep(scroll_pause)
    else:
        print(f"  Hit max-scrolls cap ({max_scrolls}) without crossing cutoff")

    print("=" * 60)
    print(f"Backfill since {since_str}: collected {len(collected)} | inserted {new} | "
          f"already-present {dup} | reached_cutoff={reached_cutoff}")
    return reached_cutoff
