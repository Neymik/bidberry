#!/usr/bin/env python3
"""Navigate to the 'Лента заказов' feed, parked at the top (version-aware shim).

Detects the installed WB Partners version and dispatches to ui.feed_v1 (2.31.x,
emulator) or ui.feed_v2 (2.34+, production phone). Pure ADB; idempotent enough
to retry.

Usage:
    python3 open_feed.py [--serial emulator-5554]
"""
import argparse
import sys

from ui import detect_app_version, get_feed_module


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--serial", default="emulator-5554", help="adb device serial")
    args = ap.parse_args()

    mod = get_feed_module(args.serial)
    print(f"WB Partners {detect_app_version(args.serial) or '?'} -> {mod.__name__}")
    return mod.open_feed(args.serial)


if __name__ == "__main__":
    sys.exit(main())
