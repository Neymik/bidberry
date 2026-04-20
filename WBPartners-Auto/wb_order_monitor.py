#!/usr/bin/env python3
"""
WB Partners Order Feed Monitor
Refreshes "Лента заказов" periodically, parses orders, stores in DB, sends new ones to Telegram.
"""

import uiautomator2 as u2
import time
import os
import subprocess
import requests
from datetime import datetime
from xml.etree import ElementTree
from dotenv import load_dotenv

from db import init_db, upsert_order, get_all_keys, build_key
from bot import run_bot_thread
from api import run_api_thread

load_dotenv()

# Fix socks proxy scheme for httpx compatibility
_all_proxy = os.environ.get("ALL_PROXY", "") or os.environ.get("all_proxy", "")
if _all_proxy.startswith("socks://"):
    fixed = _all_proxy.replace("socks://", "socks5://", 1)
    os.environ["ALL_PROXY"] = fixed
    os.environ["all_proxy"] = fixed

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

REFRESH_INTERVAL = 180  # seconds between refreshes (3 min)
SCROLL_PAUSE = 2
MAX_SCROLLS = 300  # hard safety cap — real exit is boundary (known key) or crossing today's midnight
NO_PROGRESS_LIMIT = 3  # scrolls without any new card → break + warn

# Required fields — skip partially rendered cards
REQUIRED_FIELDS = ("article", "status", "date", "price")

# Recovery state (module-level so handle_error_state can escalate across cycles)
_consecutive_errors = 0
_last_stuck_alert_ts = 0.0  # for rate-limiting the "could not recover" Telegram alert
_recovering = False         # re-entrancy guard: handle_error_state calls navigate_to_orders
                            # at tier 2+, and navigate_to_orders calls handle_error_state —
                            # without this flag one failed cycle would burn through all tiers.


def trigger_bidberry_report():
    """Notify bidberry backend to send an updated cabinet report via Telegram.
    Fire-and-forget — errors are logged and swallowed."""
    cabinet_id = os.getenv("BIDBERRY_CABINET_ID")
    if not cabinet_id:
        return
    base = os.getenv("BIDBERRY_URL", "http://127.0.0.1:3000")
    url = f"{base}/api/trigger/cabinet-report/{cabinet_id}"
    try:
        # Short timeout: the endpoint returns 202 immediately
        requests.post(url, timeout=3)
    except Exception as e:
        print(f"  bidberry trigger failed: {e}")


def send_telegram(text):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"}
    try:
        resp = requests.post(url, json=payload, timeout=10)
        if not resp.ok:
            print(f"  Telegram error: {resp.status_code} {resp.text}")
    except Exception as e:
        print(f"  Telegram send failed: {e}")


def format_order_message(order):
    status = order.get("status", "?")
    emoji = {"\u0417\u0430\u043a\u0430\u0437": "\u2705", "\u041e\u0442\u043a\u0430\u0437": "\u274c", "\u0412\u044b\u043a\u0443\u043f": "\U0001f4b0", "\u0412\u043e\u0437\u0432\u0440\u0430\u0442": "\u21a9\ufe0f"}.get(status, "\u2753")
    lines = [
        f"{emoji} <b>{status}</b>",
        f"",
        f"\U0001f457 {order.get('product', '?')}",
        f"\U0001f4e6 Артикул: <code>{order.get('article', '?')}</code> | {order.get('vendor_code', '')}",
        f"\U0001f4cf Размер: {order.get('size', '?')} | {order.get('quantity', '?')}",
        f"\U0001f4b5 {order.get('price', '?')}",
        f"\U0001f4c5 {order.get('date', '?')}",
    ]
    if order.get("arrival_city"):
        lines.append(f"\U0001f4cd {order['arrival_city']}")
    if order.get("warehouse"):
        lines.append(f"\U0001f3ed {order['warehouse']}")
    return "\n".join(lines)


def connect_device():
    device_addr = os.getenv("ANDROID_DEVICE", "")
    if device_addr:
        d = u2.connect(device_addr)
    else:
        d = u2.connect()
    print(f"Connected to: {d.info['productName']} ({device_addr or 'default'})")
    return d


def _adb_force_stop(package):
    serial = os.getenv("ANDROID_DEVICE", "")
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    cmd += ["shell", "am", "force-stop", package]
    subprocess.run(cmd, capture_output=True)


def _adb_shell(args):
    """Run an `adb shell` command against the configured device. Returns CompletedProcess."""
    serial = os.getenv("ANDROID_DEVICE", "")
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    cmd += ["shell"] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True)


# Network-recovery rate limit (seconds). Prevents thrashing wifi if issue is WB backend side.
NETWORK_RECOVERY_COOLDOWN = 600
_last_network_recovery_ts = 0.0


def try_network_recovery(reason: str) -> bool:
    """Attempt phone-side network recovery (observed to fix the monitor after the 2026-04-18 outage):

      1. `svc usb setFunctions adb` — drops MTP/mass_storage so charger can pull higher current
         while keeping ADB alive. Cheap and idempotent.
      2. `svc wifi disable` + `svc wifi enable` — breaks ASSOCIATING loops where the supplicant
         is stuck cycling on the same SSID without ever completing handshake.

    Rate-limited to NETWORK_RECOVERY_COOLDOWN (10 min) so if WB's backend is down we don't
    keep slamming the radios. Returns True if recovery ran, False if rate-limited.
    """
    global _last_network_recovery_ts
    now = time.time()
    if now - _last_network_recovery_ts < NETWORK_RECOVERY_COOLDOWN:
        remaining = int(NETWORK_RECOVERY_COOLDOWN - (now - _last_network_recovery_ts))
        print(f"  Network recovery skipped (cooldown: {remaining}s left)")
        return False
    _last_network_recovery_ts = now

    print(f"  🔧 Network recovery ({reason})")
    send_telegram(
        f"🔧 WB Monitor: пробую восстановить связь ({reason}). "
        f"USB → ADB-only (для зарядки), Wi-Fi перезапуск."
    )
    # USB first — no network disruption, higher charging current
    _adb_shell(["svc", "usb", "setFunctions", "adb"])
    # Wifi restart — breaks supplicant ASSOCIATING loops
    _adb_shell(["svc", "wifi", "disable"])
    time.sleep(2)
    _adb_shell(["svc", "wifi", "enable"])
    time.sleep(8)  # give the supplicant time to associate and pick up DHCP
    return True


def _is_error_screen(d):
    """True if the WB Partners error screen ("Что-то пошло не так" + Обновить) is showing."""
    if d(text="Что-то пошло не так").exists(timeout=1):
        return True
    # Fallback: Обновить alone (e.g. caption briefly off-screen)
    return d(text="Обновить").exists(timeout=1)


def handle_error_state(d):
    """Detect and recover from WB Partners error screens.

    Escalates on consecutive failures: tap → re-navigate → app restart → ADB force-stop.
    Returns True if an error was detected and a recovery step was taken."""
    global _consecutive_errors, _last_stuck_alert_ts, _recovering

    if _recovering:
        # Called re-entrantly (from navigate_to_orders inside an escalation) — skip
        return False

    if not _is_error_screen(d):
        return False

    _consecutive_errors += 1
    attempt = _consecutive_errors
    print(f"  Error screen detected (attempt {attempt}), recovering...")

    _recovering = True
    try:
        _do_recovery(d, attempt)
    finally:
        _recovering = False
    return True


def _do_recovery(d, attempt):
    global _last_stuck_alert_ts
    if attempt <= 2:
        # Tier 1: tap "Обновить" and wait
        btn = d(text="Обновить")
        if btn.exists(timeout=1):
            btn.click()
        time.sleep(3)
    elif attempt == 3:
        # Tier 2: re-enter feed via dashboard carousel
        print("  Escalating: re-navigating via dashboard...")
        send_telegram(
            f"\U0001f504 WB Monitor: восстановление после ошибки (попытка {attempt}/5)"
        )
        navigate_to_orders(d)
    elif attempt == 4:
        # Tier 3: try network recovery first (often the root cause), then restart the app
        try_network_recovery(f"app error recovery attempt {attempt}")
        print("  Escalating: app_stop + app_start...")
        try:
            d.app_stop("wb.partners")
            time.sleep(2)
            d.app_start("wb.partners")
            time.sleep(5)
        except Exception as e:
            print(f"  app restart failed: {e}")
        navigate_to_orders(d)
    else:
        # Tier 4 (attempt >= 5): hard force-stop via ADB + cold start
        print("  Escalating: ADB force-stop + cold start...")
        _adb_force_stop("wb.partners")
        time.sleep(2)
        try:
            d.app_start("wb.partners")
            time.sleep(5)
        except Exception as e:
            print(f"  cold start failed: {e}")
        navigate_to_orders(d)

        # Rate-limit the "stuck" alert to once per 30 min so we don't spam
        now_ts = time.time()
        if now_ts - _last_stuck_alert_ts > 1800:
            send_telegram(
                f"\u26a0\ufe0f WB Monitor: не удалось восстановиться после {attempt} попыток. "
                "Проверь телефон."
            )
            _last_stuck_alert_ts = now_ts


def reset_error_counter():
    """Call after a successful parse to clear the escalation counter."""
    global _consecutive_errors
    if _consecutive_errors:
        print(f"  Recovered (was {_consecutive_errors} consecutive errors)")
    _consecutive_errors = 0


def navigate_to_orders(d):
    """Navigate to Лента заказов page via dashboard carousel."""
    serial = os.getenv("ANDROID_DEVICE", "")
    print("  Navigating to Лента заказов...")

    # Handle error screens first (e.g. "Что-то пошло не так")
    handle_error_state(d)

    # Already on order list?
    header = d(resourceId="top_app_bar_header_text", text="Лента заказов")
    if header.exists(timeout=2):
        print("  Already on Лента заказов")
        return True

    # Ensure WB Partners is in foreground
    current = d.app_current()
    if current.get("package") != "wb.partners":
        d.app_start("wb.partners")
        time.sleep(5)

    # Navigate back to main dashboard (press back until no back button)
    for _ in range(5):
        btn = d(resourceId="top_app_bar_back_button")
        if btn.exists(timeout=1):
            btn.click()
            time.sleep(1)
        else:
            break
    time.sleep(1)

    # Scroll to top
    try:
        d(scrollable=True, packageName="wb.partners").scroll.toBeginning()
    except Exception:
        pass
    time.sleep(1)

    # Scroll down to Лента заказов section
    for _ in range(6):
        d.swipe_ext("up", scale=0.5)
        time.sleep(1.5)
        if d(text="Лента заказов").exists:
            break

    if not d(text="Лента заказов").exists:
        print("  Warning: Лента заказов not found on dashboard")
        return False

    # Swipe order carousel left to reveal "Все заказы"
    adb_args = ["adb"]
    if serial:
        adb_args += ["-s", serial]
    subprocess.run(adb_args + ["shell", "input", "swipe", "900", "2080", "100", "2080", "300"])
    time.sleep(1.5)

    # Tap "Все заказы" (avoiding floating bot button at ~[906,2056])
    subprocess.run(adb_args + ["shell", "input", "tap", "880", "2045"])
    time.sleep(3)

    # Verify we landed on Лента заказов page
    header = d(resourceId="top_app_bar_header_text", text="Лента заказов")
    if header.exists(timeout=3):
        print("  Opened Лента заказов")
        return True

    print("  Warning: navigation may have failed")
    return False


def adb_swipe(x1, y1, x2, y2, dur=300):
    """Use ADB shell input swipe to bypass Huawei INJECT_EVENTS issue."""
    serial = os.getenv("ANDROID_DEVICE", "")
    cmd = ["adb"]
    if serial:
        cmd += ["-s", serial]
    cmd += ["shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(dur)]
    subprocess.run(cmd, capture_output=True)


def pull_to_refresh(d):
    """Trigger pull-to-refresh and wait for the feed to actually update.

    Exits early either when the top card key changes (new content arrived) or
    when the top card is stable for STABLE_AFTER seconds with no error screen.
    Worst case: 10s deadline then fall through.
    """
    w, h = d.window_size()
    before_top = _top_card_key(d)
    adb_swipe(w // 2, int(h * 0.4), w // 2, int(h * 0.8), 300)

    start = time.time()
    MAX_WAIT = 10.0
    STABLE_AFTER = 2.0  # require 2s of "nothing new" before declaring done
    while (time.time() - start) < MAX_WAIT:
        time.sleep(0.5)
        after_top = _top_card_key(d)
        elapsed = time.time() - start
        if after_top and after_top != before_top:
            return  # new top card arrived
        if elapsed >= STABLE_AFTER and after_top and not _is_error_screen(d):
            return  # stable top card, not an error → assume done with no new content
    print("  pull_to_refresh: deadline exceeded, continuing anyway")


_last_parse_reason = "ok"  # "ok" | "error_screen" | "no_container" | "empty_feed"


def parse_orders_from_hierarchy(d):
    """Dump UI hierarchy and parse all visible order cards from Лента заказов page.

    Page structure: scrollable container has flat children — wb_image Views
    separate order cards. Text fields use labeled pairs (e.g., "Дата оформления" + value).

    Sets module-level `_last_parse_reason` so callers can tell WHY a parse
    returned an empty list ("error_screen" / "no_container" / "empty_feed" / "ok").
    """
    global _last_parse_reason
    xml_str = d.dump_hierarchy()

    # Fast bail-out: error screen has no scrollable feed — skip the full scroll loop
    if "Что-то пошло не так" in xml_str:
        print("  Error screen visible in hierarchy — skipping parse")
        _last_parse_reason = "error_screen"
        return []

    root = ElementTree.fromstring(xml_str)

    orders = []
    dropped_incomplete = 0

    # Find scrollable container in wb.partners
    scrollable = None
    for node in root.iter():
        if node.get("scrollable") == "true" and node.get("package") == "wb.partners":
            scrollable = node
            break

    if scrollable is None:
        print("  Warning: scrollable container not found")
        _last_parse_reason = "no_container"
        return orders

    # Each direct child of scrollable is a complete order card (View wrapping
    # wb_image + TextViews). Iterate cards, collect nested text nodes per card.
    for card in scrollable:
        texts = []
        for node in card.iter():
            text = node.get("text", "").strip()
            if text:
                texts.append(text)

        if len(texts) < 4:
            dropped_incomplete += 1
            continue

        order = {}
        # Product name = first non-field text. If first text looks like an article
        # (pure digits), the real name was cropped off screen.
        product = texts[0]
        if product.isdigit() or product in ("Дата оформления", "Стоимость", "Прибытие", "Склад WB"):
            product = ""
        order["product"] = product
        order["status"] = "Заказ"  # Default — tab filter determines actual status

        for i, text in enumerate(texts):
            if text.isdigit() and len(text) > 5:
                order["article"] = text
                # Vendor code follows article (e.g., "БркФтр2Млнж")
                if i + 1 < len(texts):
                    vc = texts[i + 1]
                    if not vc.isdigit() and not vc.startswith("Размер") and "шт" not in vc:
                        order["vendor_code"] = vc
            elif text.startswith("Размер"):
                order["size"] = text.replace("Размер ", "")
            elif "шт" in text and len(text) < 10:
                order["quantity"] = text
            elif "₽" in text:
                order["price"] = text
            elif text == "Дата оформления" and i + 1 < len(texts):
                order["date"] = texts[i + 1]
            elif text == "Прибытие" and i + 1 < len(texts):
                order["arrival_city"] = texts[i + 1]
            elif text == "Склад WB" and i + 1 < len(texts):
                order["warehouse"] = texts[i + 1]

        # Also detect date by Russian month pattern if not found via label
        if not order.get("date"):
            for text in texts:
                if ":" in text and any(m in text for m in
                    ["янв", "фев", "мар", "апр", "май", "июн",
                     "июл", "авг", "сен", "окт", "ноя", "дек"]):
                    order["date"] = text
                    break

        # Skip incomplete cards
        missing = [f for f in REQUIRED_FIELDS if not order.get(f)]
        if missing:
            dropped_incomplete += 1
            continue

        order["key"] = build_key(order)
        orders.append(order)

    # Second pass: record each card's neighbors in this dump (diagnostic fields,
    # not part of the unique key). Scoped to one hierarchy dump — no cross-scroll bookkeeping.
    for i, o in enumerate(orders):
        o["previous_order_key"] = orders[i - 1]["key"] if i > 0 else None
        o["next_order_key"]     = orders[i + 1]["key"] if i + 1 < len(orders) else None

    if dropped_incomplete:
        print(f"  Parsed {len(orders)} cards, dropped {dropped_incomplete} incomplete")
    _last_parse_reason = "ok" if orders else "empty_feed"
    return orders


def _top_card_key(d):
    """Best-effort: return the key of the topmost visible card, or None."""
    try:
        orders = parse_orders_from_hierarchy(d)
        return orders[0]["key"] if orders else None
    except Exception:
        return None


def _today_msk_midnight():
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


def collect_new_orders(d, known_keys):
    """Scroll down collecting new orders until one of:
      (a) a known-key boundary is hit in the feed (steady-state — usually 1–2 scrolls),
      (b) the oldest visible parsed date drops below today's 00:00 MSK (covered full day),
      (c) NO_PROGRESS_LIMIT consecutive scrolls produced zero new cards (feed misbehaving),
      (d) MAX_SCROLLS hard safety cap (should never fire in practice).

    Returns list of new orders in chronological order (oldest first).
    """
    from db import parse_russian_date  # local import to avoid top-level coupling

    new_orders = {}  # key -> order, discovery order (newest first)
    cutoff = _today_msk_midnight()
    no_progress = 0
    retry_mins = REFRESH_INTERVAL // 60
    # Track parse reasons across scrolls; the dominant one when we bail tells us why.
    reason_counts = {"error_screen": 0, "no_container": 0, "empty_feed": 0, "ok": 0}

    for scroll_i in range(MAX_SCROLLS + 1):
        orders = parse_orders_from_hierarchy(d)
        reason_counts[_last_parse_reason] = reason_counts.get(_last_parse_reason, 0) + 1
        hit_boundary = False
        added_this_scroll = 0
        oldest_on_screen = None

        for o in orders:
            key = o["key"]
            if key in known_keys:
                hit_boundary = True
            elif key not in new_orders:
                new_orders[key] = o
                added_this_scroll += 1

            parsed = parse_russian_date(o.get("date", ""))
            if parsed and (oldest_on_screen is None or parsed < oldest_on_screen):
                oldest_on_screen = parsed

        if hit_boundary:
            print(f"  Boundary (known key) at scroll {scroll_i} ({len(new_orders)} new)")
            break

        if oldest_on_screen is not None and oldest_on_screen < cutoff:
            print(f"  Boundary (crossed today 00:00 MSK) at scroll {scroll_i} "
                  f"(oldest visible: {oldest_on_screen}, {len(new_orders)} new)")
            break

        # Fast-bail on error screen: no point scrolling 3 times when we know the app is broken.
        # The main loop's handle_error_state will escalate recovery on next cycle.
        if _last_parse_reason == "error_screen":
            print(f"  ⚠️ WB Partners error screen — aborting scan (scroll {scroll_i})")
            # Try network recovery — often the "error screen" is really a dead network
            # (seen on 2026-04-18: wifi stuck ASSOCIATING, LTE unreachable). Rate-limited.
            try_network_recovery("error screen in feed")
            send_telegram(
                f"⚠️ WB Partners показывает экран ошибки. "
                f"Монитор пытается восстановиться автоматически и повторит через {retry_mins} мин."
            )
            break

        if added_this_scroll == 0:
            no_progress += 1
            if no_progress >= NO_PROGRESS_LIMIT:
                # Pick message based on dominant failure reason across the scan
                error_n = reason_counts.get("error_screen", 0)
                container_n = reason_counts.get("no_container", 0)
                empty_n = reason_counts.get("empty_feed", 0)
                if error_n >= no_progress // 2 + 1:
                    try_network_recovery("persistent error screen")
                    tg_msg = (f"⚠️ WB Partners показывает экран ошибки. "
                              f"Монитор пытается восстановиться автоматически, повтор через {retry_mins} мин.")
                elif container_n + empty_n >= no_progress:
                    try_network_recovery("feed not loading")
                    tg_msg = (f"⚠️ Лента заказов не загружается (похоже пропала связь). "
                              f"Пробую перезапустить Wi-Fi и USB, повтор через {retry_mins} мин. "
                              f"Если повторяется — проверь телефон (зарядка, интернет, WB Partners).")
                else:
                    tg_msg = (f"⚠️ Лента заказов не прокручивается. "
                              f"Собрано {len(new_orders)} заказов, пропускаю остаток, повтор через {retry_mins} мин.")
                print(f"  ⚠️ collect_new_orders stopped: no_progress={no_progress} "
                      f"reasons={reason_counts} scroll_i={scroll_i}")
                send_telegram(tg_msg)
                break
        else:
            no_progress = 0

        if scroll_i < MAX_SCROLLS:
            w, h = d.window_size()
            # Overlap swipe (~30% screen = ~one card height) so each card appears in two
            # consecutive dumps — half-rendered cards get a second chance to pass REQUIRED_FIELDS.
            adb_swipe(w // 2, int(h * 0.70), w // 2, int(h * 0.40), 300)
            time.sleep(SCROLL_PAUSE)
        if scroll_i and scroll_i % 20 == 0:
            print(f"  ... scroll {scroll_i}, collected {len(new_orders)} new")
    else:
        print(f"  ⚠️ collect_new_orders: hit MAX_SCROLLS ({MAX_SCROLLS}) safety cap "
              f"(collected {len(new_orders)} new)")
        send_telegram(
            f"⚠️ Слишком большой разрыв в ленте: проскроллил {MAX_SCROLLS} экранов и не нашёл "
            f"уже известный заказ. Сохраняю {len(new_orders)} собранных, повтор через {retry_mins} мин. "
            f"Если повторится — возможно нужен ручной recount_today."
        )

    # Reverse: orders were collected newest-first (top of feed), return oldest-first
    return list(reversed(new_orders.values()))


def main():
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in .env")
        return

    init_db()

    print("=" * 60)
    print("WB Partners Order Monitor")
    print(f"Refresh interval: {REFRESH_INTERVAL}s | Max scrolls: {MAX_SCROLLS}")
    print(f"Telegram chat: {TELEGRAM_CHAT_ID}")
    print("=" * 60)

    # Start Telegram bot in background thread
    run_bot_thread()
    print("Telegram bot started (polling for commands)")

    # Start REST API in background thread
    run_api_thread()
    api_port = os.getenv("API_PORT", "22001")
    print(f"REST API started (docs at http://localhost:{api_port}/docs)")

    d = connect_device()
    navigate_to_orders(d)
    known_keys = get_all_keys()
    print(f"Loaded {len(known_keys)} orders from database")

    send_telegram(
        "\U0001f680 <b>WB Monitor запущен</b>\n"
        f"Интервал: {REFRESH_INTERVAL // 60} мин\n"
        f"Заказов в базе: {len(known_keys)}\n\n"
        "Команды: /help"
    )

    cycle = 0
    while True:
        cycle += 1
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n--- Cycle {cycle} at {now} ---")

        new_orders = []
        parse_ok = False
        # Up to 2 refresh→parse attempts: if an error appears mid-cycle, recover and re-parse
        # immediately instead of losing REFRESH_INTERVAL seconds waiting for next cycle.
        for attempt in range(2):
            # Recover from any error screen before refreshing
            if handle_error_state(d):
                # handle_error_state already re-navigated at tier 2+; at tier 1 just re-check feed
                if _consecutive_errors <= 2:
                    navigate_to_orders(d)

            print("  Refreshing feed...")
            pull_to_refresh(d)

            # Error may have appeared as a result of the refresh itself
            if handle_error_state(d):
                continue  # retry the full refresh sequence

            # Scroll to top
            w, h = d.window_size()
            for _ in range(3):
                adb_swipe(w // 2, int(h * 0.3), w // 2, int(h * 0.8), 200)
                time.sleep(0.5)
            time.sleep(1)

            print("  Scanning for new orders...")
            new_orders = collect_new_orders(d, known_keys)

            # If parse returned empty AND the screen is actually an error, recover and retry
            if not new_orders and _is_error_screen(d):
                handle_error_state(d)
                continue

            parse_ok = True
            break

        # Re-navigate if nothing was parsed at all on first run (wrong screen, not an error)
        if parse_ok and not new_orders and not known_keys:
            print("  No orders visible — re-navigating to Лента заказов...")
            navigate_to_orders(d)
            time.sleep(2)
            new_orders = collect_new_orders(d, known_keys)

        if parse_ok:
            reset_error_counter()

        # Save new orders to DB (oldest first)
        saved_orders = []
        for order in new_orders:
            order["first_seen"] = now
            if upsert_order(order):
                saved_orders.append(order)
                known_keys.add(order["key"])
        new_orders = saved_orders

        if new_orders:
            print(f"\n  *** {len(new_orders)} NEW ORDER(S) ***")
            for o in new_orders:
                msg = format_order_message(o)
                print(f"  + [{o.get('status', '?')}] {o.get('product', '?')}")
                send_telegram(msg)
                time.sleep(0.5)
            # Trigger bidberry cabinet report for realtime summary update
            trigger_bidberry_report()
        else:
            print("  No new orders")

        # Scroll back to top
        for _ in range(3):
            adb_swipe(w // 2, int(h * 0.3), w // 2, int(h * 0.8), 200)
            time.sleep(0.5)

        print(f"  Sleeping {REFRESH_INTERVAL}s until next refresh...")
        time.sleep(REFRESH_INTERVAL)


if __name__ == "__main__":
    main()
