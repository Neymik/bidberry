#!/usr/bin/env python3
"""One-time migration: orders.json -> orders.db. Skips incomplete orders."""

import json
from db import init_db, upsert_order

REQUIRED_FIELDS = ("article", "status", "date", "price")


def migrate():
    init_db()

    with open("orders.json", "r", encoding="utf-8") as f:
        data = json.load(f)

    migrated = 0
    skipped = 0

    for key, order in data.items():
        missing = [f for f in REQUIRED_FIELDS if not order.get(f)]
        if missing:
            print(f"  SKIP {key} — missing: {', '.join(missing)}")
            skipped += 1
            continue

        order["key"] = key
        if upsert_order(order):
            migrated += 1
        else:
            skipped += 1

    print(f"\nDone: {migrated} migrated, {skipped} skipped, {len(data)} total in JSON")


if __name__ == "__main__":
    migrate()
