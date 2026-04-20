#!/usr/bin/env python3
"""Recount orders for a day by re-scanning the WB Partners "Лента заказов" feed.

Usage:
    python3 recount_today.py                      # today (MSK)
    python3 recount_today.py --date 2026-04-17    # specific day

wb-monitor.service MUST be stopped first (or use recount_today.sh wrapper).
"""

import argparse
import subprocess
import sys
import time
from datetime import datetime, timedelta

from db import init_db, parse_russian_date, upsert_order
from wb_order_monitor import (
    adb_swipe,
    connect_device,
    format_order_message,
    navigate_to_orders,
    parse_orders_from_hierarchy,
    pull_to_refresh,
    send_telegram,
)

DEFAULT_MAX_SCROLLS = 200
SCROLL_PAUSE = 2
TELEGRAM_LIMIT = 3500


def is_service_active() -> bool:
    r = subprocess.run(
        ["systemctl", "is-active", "wb-monitor.service"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() == "active"


def parse_date_for_cutoff(raw_date: str, year: int):
    """parse_russian_date with explicit year (for past-day backfills near year boundary)."""
    return parse_russian_date(raw_date, year=year)


def run(target_day, max_scrolls):
    cutoff = datetime.combine(target_day, datetime.min.time())
    cutoff_end = cutoff + timedelta(days=1)
    print(f"Recount target: {target_day} (00:00 MSK → {cutoff_end.date()} 00:00)")

    init_db()
    d = connect_device()

    if not navigate_to_orders(d):
        print("ERROR: failed to navigate to Лента заказов")
        return 2

    pull_to_refresh(d)
    time.sleep(2)

    w, h = d.window_size()
    for _ in range(3):
        adb_swipe(w // 2, int(h * 0.3), w // 2, int(h * 0.8), 200)
        time.sleep(0.5)
    time.sleep(1)

    seen_keys: set[str] = set()
    new_orders = []
    reobserved = []
    skipped_out_of_range = 0
    reached_cutoff = False
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for scroll_i in range(max_scrolls + 1):
        visible = parse_orders_from_hierarchy(d)
        oldest_on_screen = None

        for o in visible:
            key = o["key"]
            if key in seen_keys:
                continue
            seen_keys.add(key)

            date_dt = parse_date_for_cutoff(o.get("date", ""), target_day.year)
            if date_dt and (oldest_on_screen is None or date_dt < oldest_on_screen):
                oldest_on_screen = date_dt

            if date_dt and cutoff <= date_dt < cutoff_end:
                o["first_seen"] = now_str
                if upsert_order(o):
                    new_orders.append(o)
                    print(f"  + NEW [{o['status']}] {o['article']} | {o['date']} | {o['price']}")
                else:
                    reobserved.append(o)
            else:
                skipped_out_of_range += 1

        if oldest_on_screen is not None and oldest_on_screen < cutoff:
            reached_cutoff = True
            print(f"  Reached cutoff at scroll {scroll_i} (oldest visible: {oldest_on_screen})")
            break

        if scroll_i < max_scrolls:
            # Overlap swipe (~30% screen ≈ one card) — half-rendered cards get a second
            # chance to parse on the next dump.
            adb_swipe(w // 2, int(h * 0.70), w // 2, int(h * 0.40), 300)
            time.sleep(SCROLL_PAUSE)

    total_new = len(new_orders)
    total_reobs = len(reobserved)
    total_scanned = total_new + total_reobs
    scrolls_used = scroll_i  # from for-loop

    cap_warn = "" if reached_cutoff else f"\n⚠️ Scroll cap {max_scrolls} reached — may have missed older orders"
    header = (
        f"🔁 <b>Recount {target_day}</b>\n"
        f"Scanned: {total_scanned}  |  🆕 New: {total_new}  |  ♻️ Re-observed: {total_reobs}\n"
        f"Scrolls: {scrolls_used}  |  Out-of-range skipped: {skipped_out_of_range}"
        f"{cap_warn}"
    )

    print("\n" + "=" * 60)
    print(f"Recount {target_day}: {total_new} new, {total_reobs} re-observed "
          f"({total_scanned} scanned, {scrolls_used} scrolls)")
    if not reached_cutoff:
        print(f"WARNING: scroll cap {max_scrolls} reached without crossing 00:00")
    print("=" * 60)

    parts = [header, ""]
    if new_orders:
        parts.append("<b>🆕 New</b>")
        for o in new_orders:
            block = format_order_message(o)
            if sum(len(p) for p in parts) + len(block) > TELEGRAM_LIMIT:
                parts.append(f"...and {total_new - new_orders.index(o)} more (see stdout)")
                break
            parts.append(block)
            parts.append("")

    send_telegram("\n".join(parts))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", help="Target date YYYY-MM-DD in MSK (default: today)")
    ap.add_argument("--force", action="store_true",
                    help="Skip service-active check (dangerous — will fight for ADB)")
    ap.add_argument("--max-scrolls", type=int, default=DEFAULT_MAX_SCROLLS,
                    help=f"Max scroll iterations before bailing (default: {DEFAULT_MAX_SCROLLS})")
    args = ap.parse_args()

    if args.date:
        try:
            target_day = datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            print(f"ERROR: --date must be YYYY-MM-DD, got {args.date!r}")
            sys.exit(1)
    else:
        target_day = datetime.now().date()

    if not args.force and is_service_active():
        print("ERROR: wb-monitor.service is active. Stop it first:")
        print("  sudo systemctl stop wb-monitor.service")
        print("Or use wrapper: bash /home/ostap/WBPartners-Auto/recount_today.sh")
        sys.exit(1)

    sys.exit(run(target_day, max_scrolls=args.max_scrolls))


if __name__ == "__main__":
    main()
