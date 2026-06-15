#!/usr/bin/env python3
"""Idempotent migration: add soft-delete columns to orders.

Adds:
  - is_stale       INTEGER NOT NULL DEFAULT 0
  - stale_at       TEXT NULL              (ISO timestamp when soft-deleted)
  - stale_reason   TEXT NULL              (e.g. "reconcile_recent_missing")

Plus a partial index on (is_stale, date_parsed) for the reconcile query that
buckets live rows by date_parsed.

Run: ./venv/bin/python3 migrate_soft_delete.py
"""

import sqlite3
import sys

import db


def migrate():
    conn = db.get_connection()
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]

        added = []
        if "is_stale" not in cols:
            conn.execute("ALTER TABLE orders ADD COLUMN is_stale INTEGER NOT NULL DEFAULT 0")
            added.append("is_stale")
        if "stale_at" not in cols:
            conn.execute("ALTER TABLE orders ADD COLUMN stale_at TEXT")
            added.append("stale_at")
        if "stale_reason" not in cols:
            conn.execute("ALTER TABLE orders ADD COLUMN stale_reason TEXT")
            added.append("stale_reason")

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_orders_live_date "
            "ON orders(is_stale, date_parsed)"
        )
        conn.commit()

        live = conn.execute("SELECT count(*) c FROM orders WHERE is_stale = 0").fetchone()["c"]
        stale = conn.execute("SELECT count(*) c FROM orders WHERE is_stale = 1").fetchone()["c"]

        if added:
            print(f"Added columns: {', '.join(added)}")
        else:
            print("Columns already present — no changes.")
        print(f"Index idx_orders_live_date ensured.")
        print(f"Rows: live={live}, stale={stale}")
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        migrate()
    except sqlite3.Error as e:
        print(f"Migration failed: {e}", file=sys.stderr)
        sys.exit(1)
