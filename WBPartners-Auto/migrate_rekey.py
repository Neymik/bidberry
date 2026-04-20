#!/usr/bin/env python3
"""One-shot rekey of orders.db to the new dedup key formula.

Rebuilds the `orders` table with new keys computed via db.build_key().
Archives the original rows in `orders_old_before_rekey` (per CLAUDE.md convention).

Environment:
    DB_PATH  Override target DB path (default: /home/ostap/WBPartners-Auto/orders.db).

Usage:
    sudo systemctl stop wb-monitor.service
    ./venv/bin/python3 migrate_rekey.py                     # live DB
    DB_PATH=/tmp/orders.db.bak ./venv/bin/python3 migrate_rekey.py   # dry-run on copy
"""

import os
import sqlite3
import subprocess
import sys

import db as dbmod  # use module-level SCHEMA + build_key


def is_service_active() -> bool:
    r = subprocess.run(
        ["systemctl", "is-active", "wb-monitor.service"],
        capture_output=True, text=True,
    )
    return r.stdout.strip() == "active"


def run(db_path: str):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")

    # Safety: refuse if the archive table already exists from a prior run.
    existing = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='orders_old_before_rekey'"
    ).fetchall()]
    if existing:
        print(f"ERROR: orders_old_before_rekey already exists in {db_path}")
        print("This migration has already run (or a prior attempt did not clean up).")
        print("Remove/rename the archive table manually if you're sure you want to re-run:")
        print("  sqlite3 orders.db 'ALTER TABLE orders_old_before_rekey RENAME TO orders_old_before_rekey_v1'")
        return 1

    before_count = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    print(f"Rekeying {db_path} — {before_count} rows in orders")

    # Inspect current schema: which columns exist?
    cols = [r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    print(f"Current columns: {cols}")

    conn.execute("BEGIN")
    try:
        conn.execute("ALTER TABLE orders RENAME TO orders_old_before_rekey")
        conn.executescript(dbmod.SCHEMA)   # creates the new orders table

        rows = conn.execute("SELECT * FROM orders_old_before_rekey").fetchall()

        inserted = 0
        collapsed = 0
        key_changed = 0
        for r in rows:
            order = dict(r)
            old_key = order.get("key", "")
            new_key = dbmod.build_key(order)
            order["key"] = new_key
            if old_key != new_key:
                key_changed += 1

            cursor = conn.execute(
                """INSERT OR IGNORE INTO orders
                   (key, article, product, size, quantity, status, date_raw, date_parsed,
                    price, price_cents, vendor_code, category, warehouse, arrival_city,
                    first_seen, previous_order_key, next_order_key)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    new_key,
                    order.get("article", ""),
                    order.get("product", ""),
                    order.get("size", ""),
                    order.get("quantity", ""),
                    order.get("status", ""),
                    order.get("date_raw", ""),
                    order.get("date_parsed", ""),
                    order.get("price", ""),
                    order.get("price_cents", 0) or 0,
                    order.get("vendor_code"),
                    order.get("category"),
                    order.get("warehouse"),
                    order.get("arrival_city"),
                    order.get("first_seen", ""),
                    None,  # previous_order_key — not reconstructible for historical rows
                    None,  # next_order_key — same
                ),
            )
            if cursor.rowcount > 0:
                inserted += 1
            else:
                collapsed += 1

        conn.commit()
    except Exception:
        conn.rollback()
        raise

    after_count = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]

    print(f"Rows in old: {before_count}")
    print(f"Rows in new: {after_count}")
    print(f"  inserted (new key):       {inserted}")
    print(f"  collapsed (dup new key):  {collapsed}")
    print(f"  key string changed:       {key_changed}")
    print(f"Archive preserved at: orders_old_before_rekey")

    conn.close()
    return 0


def main():
    db_path = os.environ.get("DB_PATH", dbmod.DB_PATH)

    if db_path == dbmod.DB_PATH and is_service_active():
        print("ERROR: wb-monitor.service is active. Stop it first:")
        print("  sudo systemctl stop wb-monitor.service")
        sys.exit(1)

    sys.exit(run(db_path))


if __name__ == "__main__":
    main()
