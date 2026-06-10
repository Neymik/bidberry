#!/usr/bin/env python3
"""One-off backfill of WB Partners "Лента заказов" into orders.db (version-aware shim).

Detects the installed WB Partners version and dispatches to ui.feed_v1 (2.31.x:
scroll-from-top until the oldest visible order date crosses --since) or
ui.feed_v2 (2.34+: bound the feed with the date-range picker, scroll the bounded
list to its end, filter by order date in code).

Prereq: the WB Partners app must already be open on the "Лента заказов" feed
("Все" tab) — run open_feed.py first. feed_v2 re-navigates by itself if needed.

Usage:
    python3 backfill_range.py --serial emulator-5554 --since 2026-06-01
"""

import argparse

from ui import detect_app_version, get_feed_module


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serial", default="emulator-5554", help="adb device serial")
    ap.add_argument("--since", default="2026-06-01", help="collect orders dated >= this day (YYYY-MM-DD, MSK)")
    ap.add_argument("--max-scrolls", type=int, default=400)
    ap.add_argument("--scroll-pause", type=float, default=2.0)
    ap.add_argument("--no-top", action="store_true",
                    help="resume from current feed position instead of scrolling to top first")
    ap.add_argument("--stop-on-known", action="store_true",
                    help="stop at the first already-stored order (incremental 'new orders' scan; "
                         "v1 only — best-effort and ignored on v2, where sort is by status date)")
    args = ap.parse_args()

    mod = get_feed_module(args.serial)
    print(f"WB Partners {detect_app_version(args.serial) or '?'} -> {mod.__name__}")
    mod.run(args.serial, args.since, args.max_scrolls, args.scroll_pause,
            skip_top=args.no_top, stop_on_known=args.stop_on_known)


if __name__ == "__main__":
    main()
