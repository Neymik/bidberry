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
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable
from xml.etree import ElementTree
from dotenv import load_dotenv

from db import (
    init_db, upsert_order, get_all_keys, build_key,
    enqueue_pending_telegram, list_pending_telegram,
    delete_pending_telegram, bump_pending_telegram_attempts,
    get_key_status_map, update_order_status, TERMINAL_STATUSES,
)
from bot import run_bot_thread
from api import run_api_thread
from ui import detect_app_version, version_tuple

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

# Rescan cadence + lookback for status-transition detection. The boundary-break
# in collect_new_orders means inline detection only catches transitions for
# cards above the first known key — older orders need a periodic deep rescan.
# The rescan runs in-process (same orchestrator), so ADB stays single-owner
# and recount_today.py's service-active gate continues to enforce that.
SHALLOW_RESCAN_INTERVAL_SEC = int(os.getenv("RESCAN_SHALLOW_INTERVAL_SEC", "3600"))
DEEP_RESCAN_INTERVAL_SEC    = int(os.getenv("RESCAN_DEEP_INTERVAL_SEC",    "86400"))
SHALLOW_RESCAN_LOOKBACK_HOURS = 24
DEEP_RESCAN_LOOKBACK_HOURS    = 72
RESCAN_MAX_SCROLLS = 200

# Status badge emoji map; mirrors the canonical maps in bot.py:35,130 so the
# new-order, inline-transition, and rescan-digest alerts use the same glyphs.
STATUS_EMOJI = {"Заказ": "✅", "Отказ": "❌", "Выкуп": "💰", "Возврат": "↩️"}

# TODO(future): widen DEEP_RESCAN_LOOKBACK_HOURS to 21+ days once we confirm
#   the feed scrolls reliably that far. Catches the full Возврат window.
# TODO(future): persist a status_transitions history table — currently only
#   the latest status survives, so transitions are observable only via
#   Telegram alerts and journalctl log lines.
# TODO(future): if Заказ→Выкуп turns out to be too noisy, downgrade it to a
#   per-day digest while keeping Заказ→Отказ as a real-time alert.

# Telegram send retry policy — burst notifications trigger 429 (rate limit);
# without retry they dropped silently and blocked /count replies for 20-30s.
TG_MAX_ATTEMPTS = 4
TG_TOTAL_BUDGET_SEC = 120  # total time a single send may spend retrying; stays under the 180s scrape cycle
TG_BACKOFF_BASE = 2

# Required fields — skip partially rendered cards
REQUIRED_FIELDS = ("article", "status", "date", "price", "arrival_city", "warehouse")

# Status labels rendered inside each order card. Mirrors the canonical tuple
# in bot.py:103. Defined here so parser code can be unit-tested without a
# device (see test_status_detection.py).
VALID_STATUSES = ("Заказ", "Отказ", "Выкуп", "Возврат")


def detect_status(texts):
    """Return the order status label found in a card's text nodes.

    Prefers the LAST matching status word in the card's traversal order: the
    status badge renders late in the card hierarchy (after product/article/
    price/date labels), so right-to-left scanning avoids false hits on a
    product name that happens to contain a status word as a standalone token.
    Falls back to "Заказ" when no label is found (cropped/partial card),
    which preserves existing behavior for those edge cases.

    Pure helper — does not touch the device.
    """
    return next((t for t in reversed(texts) if t in VALID_STATUSES), "Заказ")

# Recovery state (module-level so handle_error_state can escalate across cycles)
_consecutive_errors = 0
_last_stuck_alert_ts = 0.0  # for rate-limiting the "could not recover" Telegram alert
_recovering = False         # re-entrancy guard: handle_error_state calls navigate_to_orders
                            # at tier 2+, and navigate_to_orders calls handle_error_state —
                            # without this flag one failed cycle would burn through all tiers.
_last_collect_reason = "ok"           # set by collect_new_orders when it bails on no_progress
_consecutive_no_container = 0         # cycles in a row where the scrollable feed wasn't found


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


def _send_telegram_once(text):
    """Single logical send with bounded retry-after + backoff.

    Returns (ok, reason) — reason is a short string on failure (used as the
    last_error field when persisting to the pending_telegram queue), or None
    on success. Does NOT persist on failure; callers decide whether to queue.
    """
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"}
    t_start = time.monotonic()
    last_reason = "unknown"
    for attempt in range(1, TG_MAX_ATTEMPTS + 1):
        resp = None
        try:
            resp = requests.post(url, json=payload, timeout=10)
        except requests.RequestException as e:
            last_reason = f"network: {e}"
            wait = min(TG_BACKOFF_BASE ** attempt, 30)
            if time.monotonic() - t_start + wait > TG_TOTAL_BUDGET_SEC:
                print(f"  Telegram give-up (network) after {attempt} attempts: {e}")
                return False, last_reason
            print(f"  Telegram network error ({e}), retry in {wait}s")
            time.sleep(wait)
            continue

        if resp.ok:
            return True, None

        status = resp.status_code
        if status == 429:
            try:
                body = resp.json()
            except ValueError:
                body = {}
            try:
                retry_after = int(body.get("parameters", {}).get("retry_after", 1))
            except (TypeError, ValueError):
                retry_after = 1
            wait = min(max(retry_after, 1), 60)
            last_reason = f"429 retry_after={wait}s"
            if time.monotonic() - t_start + wait > TG_TOTAL_BUDGET_SEC:
                print(f"  Telegram give-up (429 budget) retry_after={wait}s")
                return False, last_reason
            print(f"  Telegram 429, sleeping {wait}s")
            time.sleep(wait)
            continue

        if 500 <= status < 600:
            last_reason = f"{status}"
            wait = min(TG_BACKOFF_BASE ** attempt, 30)
            if time.monotonic() - t_start + wait > TG_TOTAL_BUDGET_SEC:
                print(f"  Telegram give-up ({status} budget) after {attempt} attempts")
                return False, last_reason
            print(f"  Telegram {status}, retry in {wait}s")
            time.sleep(wait)
            continue

        # Other 4xx — bad payload, retrying won't help
        body_preview = (resp.text or "")[:200].replace("\n", " ")
        print(f"  Telegram error {status}: {body_preview}")
        return False, f"{status}: {body_preview}"

    print(f"  Telegram give-up after {TG_MAX_ATTEMPTS} attempts")
    return False, last_reason


def send_telegram(text):
    """Send a message to Telegram. On give-up, persist to the pending_telegram
    queue so flush_pending_telegram() can retry at the next monitor cycle."""
    ok, reason = _send_telegram_once(text)
    if ok:
        return
    try:
        enqueue_pending_telegram(text, last_error=reason)
        print(f"  Telegram send queued (reason={reason})")
    except Exception as e:
        print(f"  Telegram persist failed: {e}")


def flush_pending_telegram(max_rows=20):
    """Attempt to deliver queued Telegram messages. Called at the top of each
    monitor cycle. Stops early on the first failure so we don't burn the whole
    cycle's time budget during a Telegram outage — remaining rows retry next cycle.
    """
    try:
        rows = list_pending_telegram(limit=max_rows)
    except Exception as e:
        print(f"  pending_telegram: list failed: {e}")
        return
    if not rows:
        return
    print(f"  pending_telegram: flushing {len(rows)} queued message(s)")
    for row in rows:
        ok, reason = _send_telegram_once(row["text"])
        if ok:
            delete_pending_telegram(row["id"])
        else:
            bump_pending_telegram_attempts(row["id"], last_error=reason)
            # Stop — subsequent sends almost certainly hit the same block.
            print(f"  pending_telegram: flush halted at row {row['id']} (reason={reason})")
            break


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


def _chunk_messages(parts, sep="\n\n———\n\n", limit=4000):
    """Greedy-pack HTML parts into <=limit-char chunks joined by sep.

    Telegram's sendMessage hard limit is 4096 chars; 4000 leaves ~96 chars
    headroom for the header prepend and HTML-entity expansion. A single part
    longer than limit is hard-sliced so we never emit a chunk Telegram rejects.
    """
    flat = []
    for p in parts:
        if len(p) > limit:
            for i in range(0, len(p), limit):
                flat.append(p[i : i + limit])
        else:
            flat.append(p)
    chunks, cur = [], ""
    for p in flat:
        add = (sep if cur else "") + p
        if cur and len(cur) + len(add) > limit:
            chunks.append(cur)
            cur = p
        else:
            cur += add
    if cur:
        chunks.append(cur)
    return chunks


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


def collapse_status_bar():
    """Dismiss any pulled-down notification/quick-settings shade.

    A scroll/refresh swipe colliding with a heads-up notification at the top edge
    can leave the shade stuck open, hiding the WB Partners feed and making
    parse_orders_from_hierarchy report 'scrollable container not found' forever.
    Called every cycle as cheap insurance — no-op when the shade is already closed.
    """
    _adb_shell(["cmd", "statusbar", "collapse"])


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


def _is_app_v2():
    """True when the installed WB Partners needs the 2.34+ navigation (ui.feed_v2).

    Detected per call (cheap dumpsys) so an app auto-update mid-run flips the
    path without a monitor restart. Unknown version -> v1, the historical default.
    """
    version = detect_app_version(os.getenv("ANDROID_DEVICE", "") or None)
    return bool(version) and version_tuple(version) >= (2, 33)


def _navigate_v2(d):
    """2.34+ navigation, entirely through the existing uiautomator2 session.

    MUST NOT shell out to classic `adb shell uiautomator dump` (ui.feed_v2's
    transport): starting classic uiautomator kills the u2 accessibility service,
    and the subsequent u2 self-heal kicks WB Partners back to the home screen
    mid-cycle (observed on first v2 deploy, 2026-06-10).

    Relaunches the app, dismisses popups, opens the feed via the dashboard
    'Лента заказов' row ('Ещё' on the same row), parks on the 'Все' tab so
    inline transition detection and the rescan jobs keep seeing real statuses.
    """
    print("  Navigating to Лента заказов (2.34 layout)...")
    try:
        d.app_stop("wb.partners")
        time.sleep(2)
        d.app_start("wb.partners")
        time.sleep(8)
    except Exception as e:
        print(f"  app relaunch failed: {e}")

    def on_feed_v2():
        return (d(resourceId="top_app_bar_header_text", text="Лента заказов").exists(timeout=1)
                and d(resourceId="date_picker_range_text").exists(timeout=1))

    # Dismiss stacked popups (promo sheet, update dialog, transient error screen)
    for _ in range(6):
        if on_feed_v2():
            break
        if d(text="Не сейчас").exists(timeout=1):
            print("  dismissing update dialog")
            d(text="Не сейчас").click(); time.sleep(1.5); continue
        x = d(descriptionContains="Xmark")
        if not x.exists(timeout=1):
            x = d(descriptionContains="CloseSheet")
        if x.exists(timeout=1):
            print("  closing promo sheet")
            x.click(); time.sleep(1.5); continue
        if d(text="Обновить").exists(timeout=1):
            print("  error screen — tapping Обновить")
            d(text="Обновить").click(); time.sleep(3); continue
        break

    if not on_feed_v2():
        # Scroll the dashboard down to the 'Лента заказов' section, tap its
        # row-mate 'Ещё' (NOT the Новости one — must sit on the same row).
        w, h = d.window_size()
        for _ in range(10):
            lenta = d(text="Лента заказов")
            if lenta.exists(timeout=1):
                lb = lenta.info["bounds"]
                lcy = (lb["top"] + lb["bottom"]) // 2
                if lcy > int(h * 0.70):
                    # Row sits at the bottom edge, under the floating WB
                    # assistant button (~[906,2056] on 1080x2400) — a tap there
                    # opens the Помощник chat instead. Bring the row mid-screen.
                    adb_swipe(w // 2, int(h * 0.65),
                              w // 2, int(h * 0.65) - (lcy - int(h * 0.50)), 300)
                    time.sleep(1.2)
                    continue
                target = None
                more = d(text="Ещё")
                for i in range(more.count):
                    mb = d(text="Ещё", instance=i).info["bounds"]
                    mcy = (mb["top"] + mb["bottom"]) // 2
                    if abs(mcy - lcy) < 90:
                        target = ((mb["left"] + mb["right"]) // 2, mcy)
                        break
                if target:
                    print(f"  tapping 'Ещё' next to Лента заказов at {target}")
                    d.click(*target)
                else:
                    print("  no adjacent 'Ещё' — tapping the section title")
                    lenta.click()
                time.sleep(3)
                break
            adb_swipe(w // 2, int(h * 0.70), w // 2, int(h * 0.27), 300)
            time.sleep(1.2)

    # Verify (retrying through transient error screens), then select 'Все'.
    for _ in range(5):
        if on_feed_v2():
            tab = d(resourceId="tab_name", text="Все")
            if tab.exists(timeout=2):
                tab.click()
                time.sleep(1.5)
            print("  Opened Лента заказов (2.34)")
            return True
        if d(text="Чат с Помощником").exists(timeout=1):
            # Floating assistant button swallowed a tap — back out of the chat.
            print("  landed in Помощник chat — pressing back")
            d.press("back")
            time.sleep(1.5)
            continue
        if d(text="Обновить").exists(timeout=1):
            d(text="Обновить").click()
            time.sleep(3)
            continue
        time.sleep(1.5)
    print("  Warning: 2.34 navigation failed")
    return False


def navigate_to_orders(d):
    """Navigate to Лента заказов page (version-dispatched)."""
    serial = os.getenv("ANDROID_DEVICE", "")

    if _is_app_v2():
        return _navigate_v2(d)

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
        return [], 0

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
        return orders, 0

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
        order["status"] = detect_status(texts)

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
            elif text == "Дата текущего статуса" and i + 1 < len(texts):
                # 2.34+ only. Diagnostic / boundary field — never part of the key.
                order["status_date"] = texts[i + 1]
            elif text == "Прибытие" and i + 1 < len(texts):
                order["arrival_city"] = texts[i + 1]
            elif text == "Склад WB" and i + 1 < len(texts):
                order["warehouse"] = texts[i + 1]

        # Also detect date by Russian month pattern if not found via label
        # (skipping the status-date value so it can never masquerade as the
        # order date on a card whose "Дата оформления" row was cropped).
        if not order.get("date"):
            for text in texts:
                if text == order.get("status_date"):
                    continue
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
    return orders, dropped_incomplete


def _top_card_key(d):
    """Best-effort: return the key of the topmost visible card, or None."""
    try:
        orders, _dropped = parse_orders_from_hierarchy(d)
        return orders[0]["key"] if orders else None
    except Exception:
        return None


def _today_msk_midnight():
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


def collect_new_orders(d, known_orders):
    """Scroll down collecting new orders until one of:
      (a) a known-key boundary is hit in the feed (steady-state — usually 1–2 scrolls),
      (b) the oldest visible parsed date drops below today's 00:00 MSK (covered full day),
      (c) NO_PROGRESS_LIMIT consecutive scrolls produced zero new cards (feed misbehaving),
      (d) MAX_SCROLLS hard safety cap (should never fire in practice).

    Returns (new_orders, status_updates):
      - new_orders: list of new orders in chronological order (oldest first).
      - status_updates: dict of {key: (old_status, new_status, card)} for known
        orders whose top-of-feed parse showed a different status. The caller
        is responsible for applying these via update_order_status. Inline
        detection only catches transitions for cards above the first known
        key (the boundary-break stops scrolling) — older transitions are
        picked up by the periodic rescan jobs.
    """
    from db import parse_russian_date  # local import to avoid top-level coupling

    global _last_collect_reason
    _last_collect_reason = "ok"

    new_orders = {}        # key -> order, discovery order (newest first)
    status_updates = {}    # key -> (old, new, card) for known-key transitions
    cutoff = _today_msk_midnight()
    no_progress = 0
    dropped_only_streak = 0
    retry_mins = REFRESH_INTERVAL // 60
    # Track parse reasons across scrolls; the dominant one when we bail tells us why.
    reason_counts = {"error_screen": 0, "no_container": 0, "empty_feed": 0, "ok": 0}

    for scroll_i in range(MAX_SCROLLS + 1):
        orders, dropped_incomplete = parse_orders_from_hierarchy(d)
        reason_counts[_last_parse_reason] = reason_counts.get(_last_parse_reason, 0) + 1
        hit_boundary = False
        added_this_scroll = 0
        oldest_on_screen = None

        for o in orders:
            key = o["key"]
            if key in known_orders:
                hit_boundary = True
                old = known_orders[key]
                new = o["status"]
                # First observation wins — top-of-feed render is freshest.
                if new != old and key not in status_updates:
                    status_updates[key] = (old, new, o)
            elif key not in new_orders:
                new_orders[key] = o
                added_this_scroll += 1

            # Feed position follows the status date on 2.34 (status-date sort);
            # cards without one (2.31) are positioned by their order date.
            parsed = parse_russian_date(o.get("status_date") or o.get("date", ""))
            if parsed and (oldest_on_screen is None or parsed < oldest_on_screen):
                oldest_on_screen = parsed

        # Under status-date sort a fresh transition (known key) can sit ABOVE a
        # brand-new order, so a known key alone must not stop the scan — break
        # only once a dump is all-known. On 2.31 (new orders always on top) this
        # degenerates to the old behavior at the same cost.
        if hit_boundary and added_this_scroll == 0:
            print(f"  Boundary (known keys, nothing new) at scroll {scroll_i} ({len(new_orders)} new)")
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
            # Filtering out a partial card is NOT a stuck-feed signal — the
            # overlap swipe will reveal it fully on the next dump. Counting it
            # as "no progress" would trigger a false "feed not scrolling" alert
            # when the only remaining card on screen is a persistent partial.
            # But the bypass must be bounded: on a WRONG screen (e.g. kicked to
            # the dashboard, whose widgets parse as eternal partials) every dump
            # drops incomplete "cards" and an unbounded pass would scroll
            # blindly to MAX_SCROLLS each cycle.
            if dropped_incomplete > 0:
                dropped_only_streak += 1
                if dropped_only_streak > 8:
                    no_progress += 1
            else:
                no_progress += 1
            if no_progress >= NO_PROGRESS_LIMIT:
                # Pick message based on dominant failure reason across the scan
                error_n = reason_counts.get("error_screen", 0)
                container_n = reason_counts.get("no_container", 0)
                empty_n = reason_counts.get("empty_feed", 0)
                if error_n >= no_progress // 2 + 1:
                    _last_collect_reason = "error_screen"
                    try_network_recovery("persistent error screen")
                    tg_msg = (f"⚠️ WB Partners показывает экран ошибки. "
                              f"Монитор пытается восстановиться автоматически, повтор через {retry_mins} мин.")
                elif container_n + empty_n >= no_progress:
                    _last_collect_reason = "no_container"
                    try_network_recovery("feed not loading")
                    tg_msg = (f"⚠️ Лента заказов не загружается (похоже пропала связь). "
                              f"Пробую перезапустить Wi-Fi и USB, повтор через {retry_mins} мин. "
                              f"Если повторяется — проверь телефон (зарядка, интернет, WB Partners).")
                else:
                    _last_collect_reason = "no_scroll"
                    tg_msg = (f"⚠️ Лента заказов не прокручивается. "
                              f"Собрано {len(new_orders)} заказов, пропускаю остаток, повтор через {retry_mins} мин.")
                print(f"  ⚠️ collect_new_orders stopped: no_progress={no_progress} "
                      f"reasons={reason_counts} scroll_i={scroll_i}")
                send_telegram(tg_msg)
                break
        else:
            no_progress = 0
            dropped_only_streak = 0

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

    # Straggler sweep: covers the edge case where the last real card of the scan
    # was bottom-truncated on every dump (nothing below to scroll past it). A few
    # small nudges push it into mid-viewport so it renders fully. Skipped when the
    # scan aborted on an error screen — no point scrolling a broken feed.
    if _last_parse_reason == "ok":
        STRAGGLER_SWEEPS = 3
        for sweep in range(STRAGGLER_SWEEPS):
            w, h = d.window_size()
            adb_swipe(w // 2, int(h * 0.60), w // 2, int(h * 0.40), 300)
            time.sleep(1)
            dump, _dropped = parse_orders_from_hierarchy(d)
            if _last_parse_reason != "ok":
                break
            new_in_sweep = 0
            hit_known = False
            for o in dump:
                key = o["key"]
                if key in known_orders:
                    hit_known = True
                    old = known_orders[key]
                    new = o["status"]
                    if new != old and key not in status_updates:
                        status_updates[key] = (old, new, o)
                    continue
                if key not in new_orders:
                    new_orders[key] = o
                    new_in_sweep += 1
            if new_in_sweep:
                print(f"  straggler sweep {sweep + 1}: recovered {new_in_sweep} new card(s)")
            if hit_known and new_in_sweep == 0:
                break  # confirmed past the boundary

    # Reverse: orders were collected newest-first (top of feed), return oldest-first
    return list(reversed(new_orders.values())), status_updates


def rescan_for_status_changes(d, known_orders, cutoff_dt, label):
    """Scroll back to cutoff_dt and update DB statuses for any key whose
    parsed status differs from the stored value.

    Status-update-only — does NOT insert new rows. New orders below the
    monitor boundary are picked up when the next monitor cycle's
    pull_to_refresh re-tops the feed, or by manual recount_today.py.

    Mutates known_orders in place so the next monitor cycle sees the
    updated statuses.

    Honors RESCAN_INITIAL_SILENT=1 — the first deploy reconciles every
    already-transitioned order at once, which would blast dozens of
    Telegram messages and trip 429 rate limits. Set the env var on the
    first restart, drop it on subsequent restarts.
    """
    from db import parse_russian_date  # local import to mirror collect_new_orders

    global _last_parse_reason
    print(f"  [{label} rescan] starting (cutoff={cutoff_dt.isoformat()})")
    pull_to_refresh(d)
    time.sleep(2)

    w, h = d.window_size()
    for _ in range(3):
        adb_swipe(w // 2, int(h * 0.3), w // 2, int(h * 0.8), 200)
        time.sleep(0.5)
    time.sleep(1)

    seen_keys = set()
    transitions = []   # list of (key, old, new, card)
    scrolls_used = 0
    reached_cutoff = False

    for scroll_i in range(RESCAN_MAX_SCROLLS + 1):
        scrolls_used = scroll_i
        cards, _dropped = parse_orders_from_hierarchy(d)
        if _last_parse_reason == "error_screen":
            print(f"  [{label} rescan] error screen at scroll {scroll_i} — aborting")
            break
        oldest_on_screen = None
        for c in cards:
            key = c["key"]
            if key in seen_keys:
                continue
            seen_keys.add(key)
            # Status date when present (2.34 status-date sort): the rescan walks
            # the feed in status-date order, so cutting off by status date covers
            # exactly every transition inside the lookback window.
            parsed = parse_russian_date(c.get("status_date") or c.get("date", ""))
            if parsed and (oldest_on_screen is None or parsed < oldest_on_screen):
                oldest_on_screen = parsed
            if key in known_orders:
                old = known_orders[key]
                new = c["status"]
                if new != old and update_order_status(key, new):
                    known_orders[key] = new
                    transitions.append((key, old, new, c))

        if oldest_on_screen is not None and oldest_on_screen < cutoff_dt:
            reached_cutoff = True
            break

        if scroll_i < RESCAN_MAX_SCROLLS:
            adb_swipe(w // 2, int(h * 0.70), w // 2, int(h * 0.40), 300)
            time.sleep(SCROLL_PAUSE)

    print(f"  [{label} rescan] scanned {len(seen_keys)} unique keys, "
          f"updated {len(transitions)}, scrolls={scrolls_used}, "
          f"reached_cutoff={reached_cutoff}")

    if not transitions:
        return

    if os.getenv("RESCAN_INITIAL_SILENT") == "1":
        print(f"  [{label} rescan] alerts suppressed (RESCAN_INITIAL_SILENT=1)")
        return

    # Digest: chunk transitions through _chunk_messages so a long window of
    # cancellations can't blast individual messages and trip Telegram 429.
    parts = []
    for _key, old, new, card in transitions:
        product = (card.get("product") or "")[:80]
        parts.append(
            f"{STATUS_EMOJI.get(new, '?')} <b>{old} → {new}</b>\n"
            f"{product}\n"
            f"Артикул: <code>{card.get('article', '?')}</code> | "
            f"{card.get('price', '?')} | {card.get('arrival_city', '?')}"
        )
    header = f"🔄 <b>Смена статусов ({label}, {len(transitions)})</b>\n\n———\n\n"
    chunks = _chunk_messages(parts)
    MAX_CHUNKS = 3
    if len(chunks) > MAX_CHUNKS:
        dropped = len(chunks) - MAX_CHUNKS
        chunks = chunks[:MAX_CHUNKS]
        chunks[-1] += f"\n\n… и ещё ~{dropped} блок(ов) переходов"
    chunks[0] = header + chunks[0]
    total = len(chunks)
    for i, chunk in enumerate(chunks, 1):
        if total > 1:
            chunk = f"<i>(part {i}/{total})</i>\n" + chunk
        send_telegram(chunk)


def run_shallow_rescan_cycle(d, state):
    cutoff = datetime.now() - timedelta(hours=SHALLOW_RESCAN_LOOKBACK_HOURS)
    rescan_for_status_changes(d, state["known_orders"], cutoff, "shallow")


def run_deep_rescan_cycle(d, state):
    cutoff = datetime.now() - timedelta(hours=DEEP_RESCAN_LOOKBACK_HOURS)
    rescan_for_status_changes(d, state["known_orders"], cutoff, "deep")


@dataclass
class Job:
    """One periodic device-bound task in the orchestrator."""
    name: str
    interval_sec: int
    fn: Callable
    next_run_ts: float = 0.0  # 0 = run immediately on first tick


def _pick_due_job(jobs, now):
    """Return the first due job (declaration-order tiebreak), or None.

    Pure helper extracted for unit tests — see test_orchestrator_due_logic.py.
    """
    for j in jobs:
        if j.next_run_ts <= now:
            return j
    return None


def orchestrator_loop(d, state):
    """Single-thread, single-device job runner.

    Three jobs share one ADB session: monitor (180s), rescan_shallow (1h, 24h
    lookback), rescan_deep (24h, 72h lookback). By construction the jobs never
    overlap on the device — while a rescan runs (~30s–3min), monitor is simply
    not started. As soon as the rescan returns, the orchestrator picks the
    next due job, which is normally monitor.

    Snapshots and restores _last_collect_reason around rescans so the
    monitor's cold-restart escalation (no_container counter) doesn't trip on
    a stale signal from rescan's parse_orders calls.
    """
    global _last_collect_reason
    while True:
        now = time.time()
        job = _pick_due_job(JOBS, now)
        if job is not None:
            print(f"[orchestrator] running: {job.name}")
            saved_collect_reason = _last_collect_reason
            try:
                job.fn(d, state)
            except Exception as e:
                import traceback
                print(f"[orchestrator] {job.name} failed: {e}")
                traceback.print_exc()
            finally:
                if job.name.startswith("rescan_"):
                    # Rescans end at the bottom of the feed; renavigate so the
                    # next monitor cycle's pull_to_refresh hits feed-top.
                    try:
                        navigate_to_orders(d)
                    except Exception as e:
                        print(f"[orchestrator] post-{job.name} renavigate failed: {e}")
                    # Restore monitor's escalation signal.
                    _last_collect_reason = saved_collect_reason
                # Reset cadence AFTER the job — a long deep rescan can't queue
                # up missed shallow rescans, and the next-pick is always
                # relative to actual completion time.
                job.next_run_ts = time.time() + job.interval_sec
            continue
        # No job due. Sleep until the next one is, capped at 30s for signal
        # responsiveness. min over (>=0) so we never pass a negative number
        # to time.sleep.
        nap = max(0.5, min(j.next_run_ts - now for j in JOBS))
        time.sleep(min(nap, 30))


# Declaration order is the tiebreak when multiple jobs are due simultaneously.
# Monitor first so steady-state new-order detection always wins ties.
JOBS = [
    Job("monitor",        REFRESH_INTERVAL,            fn=None),
    Job("rescan_shallow", SHALLOW_RESCAN_INTERVAL_SEC, fn=None),
    Job("rescan_deep",    DEEP_RESCAN_INTERVAL_SEC,    fn=None),
]


def run_monitor_cycle(d, state):
    """One iteration of the regular monitor loop — refresh feed, parse top,
    apply inline status transitions, save new orders.

    Refactored from main()'s former while-True body. The trailing
    time.sleep(REFRESH_INTERVAL) is removed; cadence is the orchestrator's job.
    """
    global _consecutive_no_container, _last_collect_reason
    state["cycle"] = state.get("cycle", 0) + 1
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n--- Cycle {state['cycle']} at {now_str} ---")

    # Replay any Telegram messages that couldn't be delivered in earlier cycles.
    flush_pending_telegram()

    new_orders = []
    status_updates = {}
    parse_ok = False
    w, h = d.window_size()
    # Up to 2 refresh→parse attempts: if an error appears mid-cycle, recover and re-parse
    # immediately instead of losing REFRESH_INTERVAL seconds waiting for next cycle.
    for _attempt in range(2):
        # Recover from any error screen before refreshing
        if handle_error_state(d):
            # handle_error_state already re-navigated at tier 2+; at tier 1 just re-check feed
            if _consecutive_errors <= 2:
                navigate_to_orders(d)

        # Dismiss any leftover notification shade before refreshing — a
        # heads-up notification colliding with a swipe can leave it stuck open.
        collapse_status_bar()

        print("  Refreshing feed...")
        pull_to_refresh(d)

        # Error may have appeared as a result of the refresh itself
        if handle_error_state(d):
            continue  # retry the full refresh sequence

        # Scroll to top
        for _ in range(3):
            adb_swipe(w // 2, int(h * 0.3), w // 2, int(h * 0.8), 200)
            time.sleep(0.5)
        time.sleep(1)

        print("  Scanning for new orders...")
        new_orders, status_updates = collect_new_orders(d, state["known_orders"])

        # If parse returned empty AND the screen is actually an error, recover and retry
        if not new_orders and not status_updates and _is_error_screen(d):
            handle_error_state(d)
            continue

        parse_ok = True
        break

    # Re-navigate if nothing was parsed at all on first run (wrong screen, not an error)
    if (parse_ok and not new_orders and not status_updates
            and not state["known_orders"]):
        print("  No orders visible — re-navigating to Лента заказов...")
        navigate_to_orders(d)
        time.sleep(2)
        new_orders, status_updates = collect_new_orders(d, state["known_orders"])

    if parse_ok:
        reset_error_counter()

        # Persistent "no scrollable container" usually means the WB Partners
        # UI is hung on a loading screen or a system overlay. Wi-Fi toggle
        # (try_network_recovery) won't fix that, so escalate to a cold start
        # of the app after 2 cycles in a row.
        if _last_collect_reason == "no_container":
            _consecutive_no_container += 1
            if _consecutive_no_container >= 2:
                print(f"  Persistent no_container ({_consecutive_no_container}× cycles) — cold-starting WB Partners")
                send_telegram(
                    f"🔄 WB Monitor: лента не отображается {_consecutive_no_container} цикла подряд, "
                    "перезапускаю WB Partners."
                )
                _adb_force_stop("wb.partners")
                time.sleep(2)
                try:
                    d.app_start("wb.partners")
                    time.sleep(5)
                except Exception as e:
                    print(f"  cold start failed: {e}")
                navigate_to_orders(d)
                _consecutive_no_container = 0
        else:
            _consecutive_no_container = 0

    # Apply inline status transitions: top-of-feed only, fire one alert each.
    # Rare in steady state (≤2 per cycle), so individual messages are fine —
    # bulk transitions go through the rescan digest path instead.
    for key, (old, new, card) in status_updates.items():
        if update_order_status(key, new):
            state["known_orders"][key] = new
            if new in TERMINAL_STATUSES:
                product = (card.get("product") or "")[:80]
                send_telegram(
                    f"{STATUS_EMOJI[new]} <b>Смена статуса:</b> {old} → {new}\n"
                    f"{product}\n"
                    f"Артикул: <code>{card.get('article', '?')}</code> | "
                    f"{card.get('price', '?')} | {card.get('arrival_city', '?')}"
                )

    # Save new orders to DB (oldest first)
    saved_orders = []
    for order in new_orders:
        order["first_seen"] = now_str
        if upsert_order(order):
            saved_orders.append(order)
            state["known_orders"][order["key"]] = order["status"]
    new_orders = saved_orders

    if new_orders:
        print(f"\n  *** {len(new_orders)} NEW ORDER(S) ***")
        parts = []
        for o in new_orders:
            print(f"  + [{o.get('status', '?')}] {o.get('product', '?')}")
            parts.append(format_order_message(o))
        header = f"🆕 <b>{len(new_orders)} new order(s)</b>\n\n———\n\n"
        chunks = _chunk_messages(parts)
        MAX_CHUNKS = 3
        if len(chunks) > MAX_CHUNKS:
            dropped = len(chunks) - MAX_CHUNKS
            chunks = chunks[:MAX_CHUNKS]
            chunks[-1] += f"\n\n… и ещё ~{dropped} блок(ов) заказов, см. /orders"
        chunks[0] = header + chunks[0]
        total = len(chunks)
        for i, chunk in enumerate(chunks, 1):
            if total > 1:
                chunk = f"<i>(part {i}/{total})</i>\n" + chunk
            send_telegram(chunk)
        # Trigger bidberry cabinet report for realtime summary update
        trigger_bidberry_report()
    else:
        print("  No new orders")

    # Scroll back to top
    for _ in range(3):
        adb_swipe(w // 2, int(h * 0.3), w // 2, int(h * 0.8), 200)
        time.sleep(0.5)


# Wire job functions into JOBS now that they're all defined.
JOBS[0].fn = run_monitor_cycle
JOBS[1].fn = run_shallow_rescan_cycle
JOBS[2].fn = run_deep_rescan_cycle


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
    known_orders = get_key_status_map()
    print(f"Loaded {len(known_orders)} orders from database")

    send_telegram(
        "\U0001f680 <b>WB Monitor запущен</b>\n"
        f"Интервал: {REFRESH_INTERVAL // 60} мин\n"
        f"Заказов в базе: {len(known_orders)}\n\n"
        "Команды: /help"
    )

    state = {"known_orders": known_orders, "cycle": 0}
    orchestrator_loop(d, state)


if __name__ == "__main__":
    main()
