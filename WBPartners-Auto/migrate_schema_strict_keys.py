#!/usr/bin/env python3
"""One-shot: rebuild orders table with NOT NULL + CHECK(length > 0) on every
key-contributing column so partial cards can never silently land in the DB again.

Columns tightened:
  article       NOT NULL  +  CHECK(length(article)     > 0)
  date_parsed   NOT NULL  +  CHECK(length(date_parsed) > 0)
  price_cents   NOT NULL  +  CHECK(price_cents         > 0)
  quantity      NOT NULL  +  CHECK(length(quantity)    > 0)
  warehouse     NOT NULL  +  CHECK(length(warehouse)   > 0)   [NEW]
  arrival_city  NOT NULL  +  CHECK(length(arrival_city)> 0)   [NEW]
  key           NOT NULL UNIQUE + CHECK(length(key)    > 0)

Not tightened (intentional):
  vendor_code — nullable/empty is a legitimate code path; build_key falls back
                to "A:{article}" when vendor_code is empty (see db.py build_key).
  size        — 431 legacy rows with empty size are a separate parser bug and
                out of scope for this migration.

Run cleanup_empty_wh.py FIRST. This script pre-flights every new constraint
and refuses to run if any surviving row would violate the new schema.

Usage:
    python3 migrate_schema_strict_keys.py            # pre-flight + dry-run
    python3 migrate_schema_strict_keys.py --confirm  # backup + rebuild table
"""

import shutil
import sqlite3
import sys
from datetime import datetime

from db import DB_PATH


PREFLIGHT_QUERIES = {
    "article empty":      "SELECT COUNT(*) FROM orders WHERE article IS NULL OR length(article) = 0",
    "date_parsed empty":  "SELECT COUNT(*) FROM orders WHERE date_parsed IS NULL OR length(date_parsed) = 0",
    "price_cents <= 0":   "SELECT COUNT(*) FROM orders WHERE price_cents IS NULL OR price_cents <= 0",
    "quantity empty":     "SELECT COUNT(*) FROM orders WHERE quantity IS NULL OR length(quantity) = 0",
    "warehouse empty":    "SELECT COUNT(*) FROM orders WHERE warehouse IS NULL OR length(warehouse) = 0",
    "arrival_city empty": "SELECT COUNT(*) FROM orders WHERE arrival_city IS NULL OR length(arrival_city) = 0",
    "key empty":          "SELECT COUNT(*) FROM orders WHERE key IS NULL OR length(key) = 0",
}

NEW_SCHEMA = """
CREATE TABLE orders_new (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    key                 TEXT    NOT NULL UNIQUE CHECK(length(key) > 0),
    article             TEXT    NOT NULL CHECK(length(article) > 0),
    product             TEXT    NOT NULL,
    size                TEXT    NOT NULL,
    quantity            TEXT    NOT NULL CHECK(length(quantity) > 0),
    status              TEXT    NOT NULL,
    date_raw            TEXT    NOT NULL,
    date_parsed         TEXT    NOT NULL CHECK(length(date_parsed) > 0),
    price               TEXT    NOT NULL,
    price_cents         INTEGER NOT NULL CHECK(price_cents > 0),
    vendor_code         TEXT,
    category            TEXT,
    warehouse           TEXT    NOT NULL CHECK(length(warehouse) > 0),
    arrival_city        TEXT    NOT NULL CHECK(length(arrival_city) > 0),
    first_seen          TEXT    NOT NULL,
    previous_order_key  TEXT,
    next_order_key      TEXT
);
"""

COPY_SQL = """
INSERT INTO orders_new
    (id, key, article, product, size, quantity, status, date_raw,
     date_parsed, price, price_cents, vendor_code, category, warehouse,
     arrival_city, first_seen, previous_order_key, next_order_key)
SELECT
    id, key, article, product, size, quantity, status, date_raw,
    date_parsed, price, price_cents, vendor_code, category, warehouse,
    arrival_city, first_seen, previous_order_key, next_order_key
FROM orders;
"""

INDEXES = [
    ("idx_orders_article",     "CREATE INDEX idx_orders_article     ON orders(article)"),
    ("idx_orders_status",      "CREATE INDEX idx_orders_status      ON orders(status)"),
    ("idx_orders_first_seen",  "CREATE INDEX idx_orders_first_seen  ON orders(first_seen)"),
    ("idx_orders_date_parsed", "CREATE INDEX idx_orders_date_parsed ON orders(date_parsed)"),
]


def preflight(conn):
    print("Pre-flight: counting rows that would violate each new constraint...")
    violations = {}
    for label, sql in PREFLIGHT_QUERIES.items():
        n = conn.execute(sql).fetchone()[0]
        print(f"  {label:22s} {n}")
        if n:
            violations[label] = n
    return violations


def main():
    confirm = "--confirm" in sys.argv[1:]
    # isolation_level=None → fully manual transactions; avoids Python sqlite3's
    # default behaviour of auto-committing DDL statements, which would break the
    # atomicity of CREATE/INSERT/DROP/ALTER/CREATE INDEX.
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    try:
        total = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        print(f"orders rows: {total}")
        print()

        violations = preflight(conn)
        if violations:
            print()
            print("REFUSING TO MIGRATE — the following rows would violate the new schema:")
            for label, n in violations.items():
                print(f"  {label}: {n}")
            print("Run cleanup_empty_wh.py --confirm first, then re-run this script.")
            return 1

        if not confirm:
            print("\n(dry-run) Pre-flight clean. Re-run with --confirm to rebuild the table.")
            return 0

        # Safety: clean any leftover orders_new from a previous failed attempt.
        conn.execute("DROP TABLE IF EXISTS orders_new")

        backup_path = f"{DB_PATH}.pre-migrate-{datetime.now().strftime('%Y-%m-%d')}"
        print(f"\nBacking up DB → {backup_path}")
        shutil.copy(DB_PATH, backup_path)

        print("Rebuilding orders table inside a transaction...")
        try:
            conn.execute("BEGIN")
            for stmt in NEW_SCHEMA.strip().rstrip(";").split(";"):
                stmt = stmt.strip()
                if stmt:
                    conn.execute(stmt)
            conn.execute(COPY_SQL)
            n_new = conn.execute("SELECT COUNT(*) FROM orders_new").fetchone()[0]
            assert n_new == total, f"row count mismatch: old={total} new={n_new}"
            conn.execute("DROP TABLE orders")
            conn.execute("ALTER TABLE orders_new RENAME TO orders")
            # Drop any leftover same-named indexes (e.g. from a prior
            # migration that bound them to orders_old_before_rekey) so the
            # fresh CREATE INDEX below doesn't collide on the name.
            for idx_name, idx_sql in INDEXES:
                conn.execute(f"DROP INDEX IF EXISTS {idx_name}")
                conn.execute(idx_sql)
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            assert integrity == "ok", f"integrity check failed: {integrity}"
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        # Report new schema
        print("\nNew table_info:")
        for row in conn.execute("PRAGMA table_info(orders)"):
            cid, name, ctype, notnull, dflt, pk = row
            print(f"  {name:22s} {ctype:10s} notnull={notnull} pk={pk}")

        after = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        print(f"\nOK — rows preserved: {after}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
