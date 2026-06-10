"""WB Partners 2.34+ UI ("Лента заказов" with date-range picker, sorted by status date).

What changed vs 2.31 (verified on the production phone, 2026-06-10):
- Feed page gained an "Все" tab, a date-range picker (rid `date_picker_range_text`,
  default last 7 days, max last 30 days) and a "Дата текущего статуса" card row.
- Cards are sorted by "Дата текущего статуса" (status date), NOT by order date —
  an old order resurfaces at the top when its status changes, so v1's
  "oldest visible order date crossed the cutoff" termination is unsound here.
- The date picker filters by STATUS date too (verified: a 09.06–09.06 range shows
  orders placed 26 мая–08.06 whose status changed on 09.06, and hides an order
  placed 09.06 whose status changed 10.06). Since status_date >= order_date,
  a backfill for orders PLACED since S must pick the range [S .. today] and
  filter by "Дата оформления" in code.
- On this account the "Лента заказов" section is still on the home dashboard
  (the Аналитика widgets page does not have it), so navigation reuses the v1
  dashboard path; an Аналитика-page fallback is kept for other UI variants.

Pure ADB (uiautomator dump + input), like feed_v1.
"""

import re
import sqlite3
import sys
import time
from datetime import datetime
from xml.etree import ElementTree

from db import build_key, get_all_keys, init_db, parse_price_cents, parse_russian_date, upsert_order

from .feed_v1 import (
    _dump_nav,
    _find,
    _nodes,
    _tap,
    dump_xml,
    make_adb,
    screen_size,
    swipe,
)

# Production schema (on the phone host) enforces NOT NULL + CHECK on warehouse,
# arrival_city and price_cents > 0, and upsert_order re-raises those violations.
# Gate cards on the same fields so a cropped card is re-read on the next overlap
# swipe instead of crashing a long backfill.
REQUIRED_FIELDS = ("article", "status", "date", "price", "quantity",
                   "arrival_city", "warehouse")

# Genitive month names as used by the calendar's accessible day labels
# ("Вторник, 9 июня 2026 г.").
MONTHS_RU_GEN = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля", 5: "мая", 6: "июня",
    7: "июля", 8: "августа", 9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
}


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_orders(xml_str):
    """Parse all visible order cards from a 2.34 Лента заказов UI dump.

    Same card-container shape as v1 (one scrollable, each direct child = one card),
    with three 2.34 adjustments:
    - status comes from the `wb_tag_text` badge node when present (more robust
      than the "Статус" label -> next-text pairing, which stays as fallback);
    - the "Дата текущего статуса" value is captured as `status_date` (diagnostic
      only — NEVER part of `date` or build_key, so keys stay DB-compatible);
    - the category line under the product name is captured as `category`.
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

    labels = ("Дата оформления", "Дата текущего статуса", "Стоимость",
              "Прибытие", "Склад WB", "Статус")

    orders = []
    for card in scrollable:
        # Keep (text, resource-id) pairs: the status badge is identified by rid.
        items = []
        for n in card.iter():
            t = (n.get("text") or "").strip()
            if t:
                items.append((t, n.get("resource-id") or ""))
        texts = [t for t, _ in items]
        if len(texts) < 4:
            continue

        order = {}
        product = texts[0]
        if product.isdigit() or product in labels:
            product = ""
        order["product"] = product
        order["status"] = "Заказ"  # default; overridden by the badge below

        consumed = set()  # indices that are label VALUES — excluded from fallbacks
        for i, (text, rid) in enumerate(items):
            nxt = texts[i + 1] if i + 1 < len(texts) else None
            if rid.endswith("wb_tag_text"):
                order["status"] = text
            elif text.isdigit() and len(text) > 5:
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
                if "status" not in order or order["status"] == "Заказ":
                    order["status"] = nxt
                consumed.add(i + 1)
            elif text == "Дата оформления" and nxt:
                order["date"] = nxt
                consumed.add(i + 1)
            elif text == "Дата текущего статуса" and nxt:
                # Diagnostic only. Explicitly consumed so it can never become `date`.
                order["status_date"] = nxt
                consumed.add(i + 1)
            elif text == "Прибытие" and nxt:
                order["arrival_city"] = nxt
                consumed.add(i + 1)
            elif text == "Склад WB" and nxt:
                order["warehouse"] = nxt
                consumed.add(i + 1)

        # Category: the line right under the product name, before the article.
        if order.get("product") and len(texts) > 2 and texts[2].isdigit():
            t1 = texts[1]
            if (not t1.isdigit() and not t1.startswith("Размер")
                    and "шт" not in t1 and "₽" not in t1 and t1 not in labels):
                order["category"] = t1

        if not order.get("date"):
            for i, text in enumerate(texts):
                if i in consumed:
                    continue  # never let the status_date value masquerade as the order date
                if ":" in text and any(m in text for m in
                    ["янв", "фев", "мар", "апр", "май", "июн",
                     "июл", "авг", "сен", "окт", "ноя", "дек"]):
                    order["date"] = text
                    break

        if any(not order.get(f) for f in REQUIRED_FIELDS):
            continue
        if not parse_price_cents(order.get("price")):
            continue  # schema CHECK(price_cents > 0)

        order["key"] = build_key(order)
        orders.append(order)
    return orders


def top_card_key(adb):
    orders = parse_orders(dump_xml(adb))
    return orders[0]["key"] if orders else None


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------

def on_feed(ns):
    """2.34 feed markers: header rid+text, tab_name tabs, date-range picker."""
    header = None
    for n in ns:
        if "top_app_bar_header_text" in n["rid"] and n["text"] == "Лента заказов":
            header = n
            break
    return (header
            and _find(ns, rid="tab_name")
            and _find(ns, rid="date_picker_range_text"))


def _dismiss_popups(adb, max_rounds=6):
    for _ in range(max_rounds):
        ns = _nodes(_dump_nav(adb))
        if on_feed(ns):
            return ns
        later = _find(ns, text="Не сейчас")
        x = _find(ns, contains="Xmark") or _find(ns, contains="CloseSheet")
        refresh = _find(ns, text="Обновить") if _find(ns, text="Что-то пошло не так") else None
        if later:
            print("  dismissing update dialog"); _tap(adb, later); continue
        if x:
            print("  closing promo sheet"); _tap(adb, x); continue
        if refresh:
            print("  error screen — tapping Обновить"); _tap(adb, refresh); time.sleep(3); continue
        return ns
    return _nodes(_dump_nav(adb))


def _tap_lenta_more(adb, ns):
    """If 'Лента заказов' + its row 'Ещё' are visible, tap and return True."""
    lenta = _find(ns, text="Лента заказов")
    if not lenta:
        return False
    for n in ns:
        if n["text"] == "Ещё" and abs(n["cy"] - lenta["cy"]) < 90:
            print(f"  tapping 'Ещё' next to Лента заказов at ({n['cx']},{n['cy']})")
            _tap(adb, n)
            return True
    print("  Лента заказов found but no adjacent 'Ещё' — tapping the section title")
    _tap(adb, lenta)
    return True


def open_feed(serial):
    """Navigate to the 'Лента заказов' feed. Returns 0 on success (like feed_v1).

    Primary path: home dashboard -> scroll to the 'Лента заказов' section -> 'Ещё'
    (still present on 2.34 for this account). Fallback for other UI variants:
    dashboard 'Аналитика' tile -> scroll its page looking for the same section.
    """
    adb = make_adb(serial)
    adb("shell", "am", "force-stop", "wb.partners")
    time.sleep(1)
    adb("shell", "monkey", "-p", "wb.partners", "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(8)  # splash + load

    ns = _dismiss_popups(adb)
    if on_feed(ns):
        print("Feed already open")
        return 0

    # Primary: scroll the home dashboard down to the 'Лента заказов' section.
    tapped = False
    for _ in range(8):
        ns = _nodes(_dump_nav(adb))
        if _tap_lenta_more(adb, ns):
            tapped = True
            break
        adb("shell", "input", "swipe", "540", "1700", "540", "650", "300")
        time.sleep(1.2)

    if not tapped:
        # Fallback: some accounts/UI variants host the feed under Аналитика.
        print("  'Лента заказов' not on dashboard — trying the Аналитика page")
        adb("shell", "am", "force-stop", "wb.partners")
        time.sleep(1)
        adb("shell", "monkey", "-p", "wb.partners", "-c", "android.intent.category.LAUNCHER", "1")
        time.sleep(8)
        ns = _dismiss_popups(adb)
        analytics = _find(ns, text="Аналитика")
        if analytics:
            _tap(adb, analytics)
            time.sleep(2)
            for _ in range(8):
                ns = _nodes(_dump_nav(adb))
                if _tap_lenta_more(adb, ns):
                    tapped = True
                    break
                adb("shell", "input", "swipe", "540", "1800", "540", "600", "300")
                time.sleep(1.2)

    # Verify (retrying through transient error screens).
    for _ in range(5):
        ns = _nodes(_dump_nav(adb))
        if on_feed(ns):
            print("Opened Лента заказов (2.34 feed)")
            return 0
        if _find(ns, text="Что-то пошло не так"):
            refresh = _find(ns, text="Обновить")
            if refresh:
                print("  error screen — tapping Обновить")
                _tap(adb, refresh)
                time.sleep(3)
                continue
        time.sleep(1.5)
    print("ERROR: could not confirm feed open", file=sys.stderr)
    return 2


def select_tab(serial, tab_text):
    """Tap a feed tab ('Все', 'Заказы', ...). Returns True if the tab was found."""
    adb = make_adb(serial)
    ns = _nodes(_dump_nav(adb))
    for n in ns:
        if "tab_name" in n["rid"] and n["text"] == tab_text:
            _tap(adb, n)
            return True
    print(f"  Warning: tab {tab_text!r} not found")
    return False


# ---------------------------------------------------------------------------
# Date-range picker
# ---------------------------------------------------------------------------

def _day_label(d):
    # Calendar day cells carry text like 'Вторник, 9 июня 2026 г.' (possibly
    # prefixed with 'Начальная дата, ' / 'Сегодня, ' etc.) — match the core part.
    return f"{d.day} {MONTHS_RU_GEN[d.month]} {d.year}"


def _find_day(ns, d):
    label = _day_label(d)
    for n in ns:
        if n["clk"] and label in (n["text"] + " " + n["desc"]):
            return n
    return None


def _tap_day(adb, d, scroll_attempts=6):
    """Tap a calendar day cell, scrolling to earlier months if needed."""
    for attempt in range(scroll_attempts + 1):
        ns = _nodes(_dump_nav(adb))
        cell = _find_day(ns, d)
        if cell:
            _tap(adb, cell)
            return True
        if attempt < scroll_attempts:
            # Earlier months are above the visible area — scroll the calendar up.
            swipe(adb, 540, 900, 540, 1700, 300)
            time.sleep(1.0)
    return False


def set_date_range(serial, start_date, end_date):
    """Open the picker and select [start_date .. end_date]. Returns True on success.

    NOTE: the picker filters by STATUS date ("Дата текущего статуса"), not order
    date. Callers wanting orders PLACED in a window must widen the range to
    'today' and filter by order date in code. Only the last 30 days are offered.
    """
    adb = make_adb(serial)
    ns = _nodes(_dump_nav(adb))
    picker = _find(ns, rid="date_picker_range_text")
    if not picker:
        print("  Warning: date picker not found on feed page")
        return False
    _tap(adb, picker)
    time.sleep(1.5)

    if not _tap_day(adb, start_date):
        print(f"  Warning: start day {start_date:%d.%m.%Y} not found in calendar "
              f"(only the last 30 days are available)")
        # Bail out of the picker without changing the range.
        adb("shell", "input", "keyevent", "4")
        time.sleep(1)
        return False
    if not _tap_day(adb, end_date):
        print(f"  Warning: end day {end_date:%d.%m.%Y} not found in calendar")
        adb("shell", "input", "keyevent", "4")
        time.sleep(1)
        return False

    ns = _nodes(_dump_nav(adb))
    apply_btn = _find(ns, text="Применить")
    if not apply_btn:
        print("  Warning: Применить button not found")
        adb("shell", "input", "keyevent", "4")
        time.sleep(1)
        return False
    _tap(adb, apply_btn)
    time.sleep(2.5)

    ns = _nodes(_dump_nav(adb))
    rng = _find(ns, rid="date_picker_range_text")
    expected_start = start_date.strftime("%d.%m.%Y")
    if rng and rng["text"].startswith(expected_start):
        print(f"  Date range set: {rng['text']}")
        return True
    print(f"  Warning: range text is {rng['text'] if rng else '?'!r}, "
          f"expected start {expected_start}")
    return False


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------

def scroll_to_top(adb, w, h, max_flings=120):
    """Fling toward the top of the feed until the top card stops changing."""
    last = None
    stable = 0
    for i in range(max_flings):
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
    """Backfill all orders PLACED on/after --since.

    Strategy (2.34): bound the feed with the date picker to [since .. today]
    (status-date filtered, and status_date >= order_date, so every order placed
    in the window is included), select the 'Все' tab, scroll the bounded list to
    its end, and upsert each card whose "Дата оформления" >= cutoff. Termination
    is "no new cards for several scrolls" — NOT the v1 date-cutoff heuristic,
    which is unsound under status-date sort.
    """
    cutoff = datetime.strptime(since_str, "%Y-%m-%d")
    adb = make_adb(serial)
    init_db()

    if stop_on_known:
        print("  NOTE: --stop-on-known is unreliable under 2.34 status-date sort — ignoring; "
              "the date-range bound provides correctness")

    w, h = screen_size(adb)
    print(f"Device {serial or '(default)'}  screen {w}x{h}  cutoff {cutoff}  (feed_v2)")

    # Make sure we're on the feed, on the 'Все' tab, with the right range.
    ns = _nodes(_dump_nav(adb))
    if not on_feed(ns):
        if open_feed(serial) != 0:
            print("ERROR: cannot open feed")
            return False
        ns = _nodes(_dump_nav(adb))
    today = datetime.now()
    expected_range = f"{cutoff:%d.%m.%Y} — {today:%d.%m.%Y}"
    rng = _find(ns, rid="date_picker_range_text")
    if rng and rng["text"] == expected_range:
        # Re-applying the picker re-renders the list at the top, which would
        # defeat --no-top resumes — leave the range alone when already right.
        print(f"  Date range already {rng['text']}")
    else:
        select_tab(serial, "Все")
        time.sleep(1.5)
        if not set_date_range(serial, cutoff, today):
            print("  Proceeding with the current/default range — coverage may be incomplete")

    if not skip_top:
        scroll_to_top(adb, w, h)
        time.sleep(1)

    seen = {}        # every key seen this run (incl. out-of-range) — drives termination
    collected = {}   # in-range orders actually stored
    no_progress = 0
    new = dup = skipped_old = bad = 0
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    end_reached = False

    for scroll_i in range(max_scrolls + 1):
        orders = parse_orders(dump_xml(adb))
        added_keys = 0
        for o in orders:
            if o["key"] in seen:
                continue
            seen[o["key"]] = True
            added_keys += 1
            d = parse_russian_date(o.get("date", ""), year=cutoff.year)
            if d and d >= cutoff:
                collected[o["key"]] = o
                # Persist immediately so a mid-scroll kill never loses progress.
                o["first_seen"] = now_str
                try:
                    if upsert_order(o):
                        new += 1
                    else:
                        dup += 1
                except sqlite3.IntegrityError as e:
                    # Schema CHECK/NOT NULL — log the whole card loudly but keep
                    # the backfill alive; one bad card must not cost the run.
                    bad += 1
                    print(f"  ⚠️ BAD CARD rejected by schema ({e}): {o}")
            else:
                # Resurfaced old order (status changed in-window, placed before it).
                skipped_old += 1

        if added_keys == 0:
            no_progress += 1
            if no_progress >= 4:
                end_reached = True
                print(f"  End of bounded list at scroll {scroll_i} "
                      f"({len(collected)} in-range, {skipped_old} older skipped)")
                break
        else:
            no_progress = 0

        if scroll_i and scroll_i % 10 == 0:
            print(f"  ... scroll {scroll_i}, {len(collected)} in-range "
                  f"({len(seen)} cards seen)")

        # Overlap swipe (~30% of screen) so each card appears in two consecutive dumps.
        swipe(adb, w // 2, int(h * 0.70), w // 2, int(h * 0.40), 300)
        time.sleep(scroll_pause)
    else:
        print(f"  Hit max-scrolls cap ({max_scrolls}) before the end of the list")

    print("=" * 60)
    print(f"Backfill since {since_str} (v2): collected {len(collected)} | inserted {new} | "
          f"already-present {dup} | older-skipped {skipped_old} | schema-rejected {bad} | "
          f"end_reached={end_reached}")
    return end_reached
