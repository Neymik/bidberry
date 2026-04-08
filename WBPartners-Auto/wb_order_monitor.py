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

from db import init_db, upsert_order, get_all_keys
from bot import run_bot_thread
from api import run_api_thread

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

REFRESH_INTERVAL = 180  # seconds between refreshes (3 min)
SCROLL_PAUSE = 2
MAX_SCROLLS = 10

# Required fields — skip partially rendered cards
REQUIRED_FIELDS = ("article", "status", "date", "price")


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


def handle_error_state(d):
    """Detect and recover from WB Partners error screens.
    Returns True if an error was handled (caller should re-navigate)."""
    # "Что-то пошло не так" error screen with Обновить button
    refresh_btn = d(text="Обновить")
    if refresh_btn.exists(timeout=1):
        print("  Error screen detected, tapping Обновить...")
        refresh_btn.click()
        time.sleep(3)
        return True
    return False


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
    w, h = d.window_size()
    adb_swipe(w // 2, int(h * 0.4), w // 2, int(h * 0.8), 300)
    time.sleep(3)


def parse_orders_from_hierarchy(d):
    """Dump UI hierarchy and parse all visible order cards from Лента заказов page.

    Page structure: scrollable container has flat children — wb_image Views
    separate order cards. Text fields use labeled pairs (e.g., "Дата оформления" + value).
    """
    xml_str = d.dump_hierarchy()
    root = ElementTree.fromstring(xml_str)

    orders = []

    # Find scrollable container in wb.partners
    scrollable = None
    for node in root.iter():
        if node.get("scrollable") == "true" and node.get("package") == "wb.partners":
            scrollable = node
            break

    if scrollable is None:
        print("  Warning: scrollable container not found")
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
            continue

        order["key"] = f"{order['article']}_{order.get('size', '')}_{order['date']}"
        orders.append(order)

    return orders


def collect_new_orders(d, known_keys):
    """Scroll down until a known order is found (boundary), collecting new orders.

    Returns list of new orders in chronological order (oldest first).
    """
    new_orders = {}  # key -> order, preserves discovery order (newest first)

    for scroll_i in range(MAX_SCROLLS + 1):
        orders = parse_orders_from_hierarchy(d)
        hit_boundary = False

        for o in orders:
            key = o["key"]
            if key in known_keys:
                hit_boundary = True
            elif key not in new_orders:
                new_orders[key] = o

        if hit_boundary:
            print(f"  Boundary found at scroll {scroll_i} ({len(new_orders)} new above)")
            break

        if scroll_i < MAX_SCROLLS:
            w, h = d.window_size()
            adb_swipe(w // 2, int(h * 0.75), w // 2, int(h * 0.3), 300)
            time.sleep(SCROLL_PAUSE)

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

        # Recover from error screens before trying to refresh
        if handle_error_state(d):
            navigate_to_orders(d)

        print("  Refreshing feed...")
        pull_to_refresh(d)

        # Scroll to top
        w, h = d.window_size()
        for _ in range(3):
            adb_swipe(w // 2, int(h * 0.3), w // 2, int(h * 0.8), 200)
            time.sleep(0.5)
        time.sleep(1)

        print("  Scanning for new orders...")
        new_orders = collect_new_orders(d, known_keys)

        # Re-navigate if nothing was parsed at all (wrong screen)
        if not new_orders and not known_keys:
            print("  No orders visible — re-navigating to Лента заказов...")
            navigate_to_orders(d)
            time.sleep(2)
            new_orders = collect_new_orders(d, known_keys)

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
