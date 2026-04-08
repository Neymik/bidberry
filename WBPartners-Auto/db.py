"""SQLite database layer for WB Partners order storage."""

import sqlite3
import os
import re
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "orders.db")

MONTHS_RU = {
    "янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "июн": 6,
    "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key           TEXT    NOT NULL UNIQUE,
    article       TEXT    NOT NULL,
    product       TEXT    NOT NULL,
    size          TEXT    NOT NULL,
    quantity      TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    date_raw      TEXT    NOT NULL,
    date_parsed   TEXT    NOT NULL,
    price         TEXT    NOT NULL,
    price_cents   INTEGER NOT NULL,
    vendor_code   TEXT,
    category      TEXT,
    warehouse     TEXT,
    arrival_city  TEXT,
    first_seen    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_article     ON orders(article);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_first_seen  ON orders(first_seen);
CREATE INDEX IF NOT EXISTS idx_orders_date_parsed ON orders(date_parsed);
"""


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # DELETE (rollback) journal instead of WAL: bidberry reads orders.db
    # through a docker single-file bind mount, which doesn't propagate the
    # sibling -wal/-shm files. WAL writes would stay invisible to bidberry
    # until checkpoint. With DELETE mode, every commit lands in orders.db
    # itself, so the bind-mounted file always reflects current state.
    # Trade-off (slower writes, no concurrent reads during write) is fine
    # for this workload: ~5-10 inserts every 3 minutes, single writer.
    conn.execute("PRAGMA journal_mode=DELETE")
    return conn


def init_db():
    conn = get_connection()
    conn.executescript(SCHEMA)
    # Migration: add vendor_code column if missing
    cols = [r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    if "vendor_code" not in cols:
        conn.execute("ALTER TABLE orders ADD COLUMN vendor_code TEXT")
        conn.commit()
    conn.close()


def parse_russian_date(date_str, year=None):
    """Parse '9 мар, 19:05' -> datetime."""
    if not date_str:
        return None
    year = year or datetime.now().year
    m = re.match(r"(\d{1,2})\s+(\w+),\s+(\d{1,2}):(\d{2})", date_str.strip())
    if not m:
        return None
    day, month_str, hour, minute = m.groups()
    month = MONTHS_RU.get(month_str)
    if not month:
        return None
    return datetime(year, month, int(day), int(hour), int(minute))


def parse_price_cents(price_str):
    """Parse '2 784 ₽' -> 278400 (kopecks)."""
    if not price_str:
        return None
    digits = re.sub(r"[^\d]", "", price_str)
    return int(digits) * 100 if digits else None


def _to_iso_dt(dt_str):
    """Bot passes 'YYYY-MM-DD HH:MM:SS'; date_parsed is stored as 'YYYY-MM-DDTHH:MM:SS'.
    Converts the former to the latter for SQL string comparison."""
    if not dt_str:
        return dt_str
    return dt_str.replace(" ", "T", 1)


def upsert_order(order_dict):
    """Insert order if key doesn't exist. Returns True if inserted (new), False if duplicate."""
    date_parsed = parse_russian_date(order_dict.get("date"))
    price_cents = parse_price_cents(order_dict.get("price"))
    first_seen = order_dict.get("first_seen") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_connection()
    try:
        cursor = conn.execute(
            """INSERT OR IGNORE INTO orders
               (key, article, product, size, quantity, status, date_raw, date_parsed,
                price, price_cents, vendor_code, category, warehouse, arrival_city, first_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                order_dict["key"],
                order_dict["article"],
                order_dict.get("product", ""),
                order_dict.get("size", ""),
                order_dict.get("quantity", ""),
                order_dict["status"],
                order_dict.get("date", ""),
                date_parsed.isoformat() if date_parsed else "",
                order_dict.get("price", ""),
                price_cents or 0,
                order_dict.get("vendor_code"),
                order_dict.get("category"),
                order_dict.get("warehouse"),
                order_dict.get("arrival_city"),
                first_seen,
            ),
        )
        conn.commit()
        return cursor.rowcount > 0
    finally:
        conn.close()


def get_all_keys():
    """Return set of all existing order keys."""
    conn = get_connection()
    try:
        rows = conn.execute("SELECT key FROM orders").fetchall()
        return {r["key"] for r in rows}
    finally:
        conn.close()


def get_recent_orders(limit=5):
    conn = get_connection()
    try:
        return conn.execute(
            "SELECT * FROM orders ORDER BY first_seen DESC LIMIT ?", (limit,)
        ).fetchall()
    finally:
        conn.close()


def get_orders_by_article(article):
    conn = get_connection()
    try:
        return conn.execute(
            "SELECT * FROM orders WHERE article = ? ORDER BY first_seen DESC",
            (article,),
        ).fetchall()
    finally:
        conn.close()


def get_orders_by_status(status, limit=20):
    conn = get_connection()
    try:
        return conn.execute(
            "SELECT * FROM orders WHERE status = ? ORDER BY first_seen DESC LIMIT ?",
            (status, limit),
        ).fetchall()
    finally:
        conn.close()


def get_orders_by_date_range(start_date, end_date):
    """Fetch orders where date_parsed falls within range. Dates as 'YYYY-MM-DD'."""
    conn = get_connection()
    try:
        return conn.execute(
            "SELECT * FROM orders WHERE date_parsed >= ? AND date_parsed <= ? ORDER BY date_parsed DESC",
            (start_date, end_date + "T23:59:59"),
        ).fetchall()
    finally:
        conn.close()


def get_stats():
    conn = get_connection()
    try:
        total = conn.execute("SELECT count(*) as c FROM orders").fetchone()["c"]
        today_iso = datetime.now().strftime("%Y-%m-%dT00:00:00")
        today_count = conn.execute(
            "SELECT count(*) as c FROM orders WHERE date_parsed >= ?", (today_iso,)
        ).fetchone()["c"]
        by_status = conn.execute(
            "SELECT status, count(*) as c FROM orders GROUP BY status ORDER BY c DESC"
        ).fetchall()
        return {
            "total": total,
            "today": today_count,
            "by_status": [(r["status"], r["c"]) for r in by_status],
        }
    finally:
        conn.close()


def get_totals(start_dt, end_dt):
    """Get order count and revenue totals for a time range.

    Filters on `date_parsed` (when the seller actually got the order from
    the WB UI), NOT on `first_seen` (when our scraper noticed). After scraper
    downtime, first_seen clusters around catch-up time and totals get warped.

    Args:
        start_dt: 'YYYY-MM-DD HH:MM:SS' (or ISO T-format — both work)
        end_dt:   'YYYY-MM-DD HH:MM:SS' (or ISO T-format)
    """
    start_iso = _to_iso_dt(start_dt)
    end_iso = _to_iso_dt(end_dt)
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT count(*) as cnt, coalesce(sum(price_cents), 0) as rev "
            "FROM orders WHERE date_parsed >= ? AND date_parsed <= ?",
            (start_iso, end_iso),
        ).fetchone()
        by_status = conn.execute(
            "SELECT status, count(*) as cnt, coalesce(sum(price_cents), 0) as rev "
            "FROM orders WHERE date_parsed >= ? AND date_parsed <= ? "
            "GROUP BY status ORDER BY cnt DESC",
            (start_iso, end_iso),
        ).fetchall()
        return {
            "count": row["cnt"],
            "revenue_cents": row["rev"],
            "by_status": [(r["status"], r["cnt"], r["rev"]) for r in by_status],
        }
    finally:
        conn.close()


def get_totals_by_article(start_dt, end_dt):
    """Get order count and revenue grouped by article for a time range.
    Filters on date_parsed — see get_totals docstring."""
    start_iso = _to_iso_dt(start_dt)
    end_iso = _to_iso_dt(end_dt)
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT article, vendor_code, count(*) as cnt, coalesce(sum(price_cents), 0) as rev "
            "FROM orders WHERE date_parsed >= ? AND date_parsed <= ? "
            "GROUP BY article ORDER BY cnt DESC",
            (start_iso, end_iso),
        ).fetchall()
        return [(r["article"], r["vendor_code"] or "", r["cnt"], r["rev"]) for r in rows]
    finally:
        conn.close()
