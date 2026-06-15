"""SQLite database layer for WB Partners order storage."""

import sqlite3
import os
import re
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "orders.db")

# Both 3-letter abbreviation (used by WB Partners for most months) AND full
# genitive form (used for "май" because the abbreviation collides with the
# nominative; observed in production 2026-05-01 → 2026-05-03 incident where
# every May order failed parse_russian_date and tripped the date_parsed
# CHECK constraint, aborting the entire monitor cycle for 3 days). Including
# all genitive forms for resilience in case WB shifts other months too.
MONTHS_RU = {
    "янв": 1, "января":   1,
    "фев": 2, "февраля":  2,
    "мар": 3, "марта":    3,
    "апр": 4, "апреля":   4,
    "май": 5, "мая":      5,
    "июн": 6, "июня":     6,
    "июл": 7, "июля":     7,
    "авг": 8, "августа":  8,
    "сен": 9, "сентября": 9,
    "окт": 10, "октября": 10,
    "ноя": 11, "ноября":  11,
    "дек": 12, "декабря": 12,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
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
    next_order_key      TEXT,
    is_stale            INTEGER NOT NULL DEFAULT 0,
    stale_at            TEXT,
    stale_reason        TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_article     ON orders(article);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_first_seen  ON orders(first_seen);
CREATE INDEX IF NOT EXISTS idx_orders_date_parsed ON orders(date_parsed);
CREATE INDEX IF NOT EXISTS idx_orders_live_date   ON orders(is_stale, date_parsed);

CREATE TABLE IF NOT EXISTS pending_telegram (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_telegram_created ON pending_telegram(created_at);
"""

# Cap the pending-telegram queue so a prolonged Telegram outage can't blow up
# the sqlite file. When exceeded, oldest rows are dropped with a log line.
PENDING_TG_MAX_ROWS = 200
# Drop a pending row after this many unsuccessful delivery attempts so a
# permanently-undeliverable message (e.g. malformed HTML) stops blocking the queue.
PENDING_TG_MAX_ATTEMPTS = 20


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
    cols = [r[1] for r in conn.execute("PRAGMA table_info(orders)").fetchall()]
    # Migration: add vendor_code column if missing
    if "vendor_code" not in cols:
        conn.execute("ALTER TABLE orders ADD COLUMN vendor_code TEXT")
    # Migration: neighbor keys (populated by monitor, diagnostic only — not unique)
    for col in ("previous_order_key", "next_order_key"):
        if col not in cols:
            conn.execute(f"ALTER TABLE orders ADD COLUMN {col} TEXT")
    # Migration: soft-delete columns (see migrate_soft_delete.py for standalone runner).
    if "is_stale" not in cols:
        conn.execute("ALTER TABLE orders ADD COLUMN is_stale INTEGER NOT NULL DEFAULT 0")
    if "stale_at" not in cols:
        conn.execute("ALTER TABLE orders ADD COLUMN stale_at TEXT")
    if "stale_reason" not in cols:
        conn.execute("ALTER TABLE orders ADD COLUMN stale_reason TEXT")
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


def build_key(order):
    """Dedup key: {vendor_code|A:article}#{size}#{qty}#{price_int}#{date_iso}#{city}#{warehouse}

    Accepts orders in both shapes: live-scraped (has raw `date`, `price`, `quantity`)
    and DB rows (has pre-parsed `date_parsed`, `price_cents`, raw `quantity`).
    Falls back gracefully when fields are missing so it never crashes.
    """
    # vendor_code, fallback to A:{article}
    vc = (order.get("vendor_code") or "").strip()
    if not vc:
        article = (order.get("article") or "").strip()
        vc = f"A:{article}" if article else ""

    size = (order.get("size") or "").strip()

    # quantity -> numeric string; accepts "1 шт" or "1" or missing
    qty_raw = order.get("quantity")
    if qty_raw is None:
        qty = ""
    else:
        qty = re.sub(r"\D", "", str(qty_raw))

    # price_int from whichever form is available
    if order.get("price_cents") is not None:
        pc = int(order["price_cents"])
    else:
        pc = parse_price_cents(order.get("price")) or 0
    price_int = str(pc // 100) if pc else ""

    # date_iso: prefer pre-parsed; else parse raw; else raw string verbatim
    date_iso = order.get("date_parsed")
    if not date_iso:
        parsed = parse_russian_date(order.get("date", ""))
        date_iso = parsed.isoformat() if parsed else (order.get("date") or "")

    city = (order.get("arrival_city") or "").strip()
    warehouse = (order.get("warehouse") or "").strip()

    parts = [vc, size, qty, price_int, date_iso, city, warehouse]
    # Always strip '#' from fields so the separator never collides with content.
    parts = [p.replace("#", "") if isinstance(p, str) else "" for p in parts]
    return "#".join(parts)


def upsert_order(order_dict):
    """Insert order if key doesn't exist. Returns True if inserted (new), False if duplicate.

    Uses plain INSERT (default conflict = ABORT) and catches IntegrityError so a
    UNIQUE collision returns False (expected) while CHECK/NOT NULL violations
    re-raise (loud — a partial card slipped the parser gate and must be investigated).
    INSERT OR IGNORE would swallow CHECK violations silently and defeat the schema.
    """
    date_parsed = parse_russian_date(order_dict.get("date"))
    price_cents = parse_price_cents(order_dict.get("price"))
    first_seen = order_dict.get("first_seen") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = get_connection()
    try:
        try:
            conn.execute(
                """INSERT INTO orders
                   (key, article, product, size, quantity, status, date_raw, date_parsed,
                    price, price_cents, vendor_code, category, warehouse, arrival_city, first_seen,
                    previous_order_key, next_order_key)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                    order_dict.get("previous_order_key"),
                    order_dict.get("next_order_key"),
                ),
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError as e:
            msg = str(e).upper()
            if "UNIQUE" in msg or "PRIMARY KEY" in msg:
                print(f"  DUP SKIP: {order_dict['key']}")
                return False
            raise
    finally:
        conn.close()


def get_all_keys():
    """Return set of currently-live order keys (excludes soft-deleted rows).

    Soft-deleted rows are kept for audit but must not appear in `known_orders`,
    or the monitor would treat a re-appeared order as already-known and skip
    re-inserting it.
    """
    conn = get_connection()
    try:
        rows = conn.execute("SELECT key FROM orders WHERE is_stale = 0").fetchall()
        return {r["key"] for r in rows}
    finally:
        conn.close()


# Statuses an order has reached its end-of-life in: customer cancelled (Отказ),
# customer picked up at ПВЗ (Выкуп), or returned within 14d (Возврат).
# update_order_status refuses to overwrite these with the parser's "Заказ"
# fallback so a missing UI label can't clobber a previously-correct status.
TERMINAL_STATUSES = ("Отказ", "Выкуп", "Возврат")


def get_key_status_map():
    """Return {key: status} for every live order (excludes soft-deleted rows).

    Used by the monitor to detect status transitions: the steady-state
    boundary check compares each parsed card's current status against the
    stored value and dispatches update_order_status only on change.

    Stale rows are excluded so a re-appeared order (after disappearing from
    the feed and being soft-deleted) is treated as new and re-inserted.
    """
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT key, status FROM orders WHERE is_stale = 0"
        ).fetchall()
        return {r["key"]: r["status"] for r in rows}
    finally:
        conn.close()


def update_order_status(key, new_status):
    """Update status column for an existing key. Return True iff a row changed.

    Guards against UI-glitch downgrades: refuses to overwrite a terminal
    status (Отказ/Выкуп/Возврат) with the parser's "Заказ" fallback, since
    a genuine reversal is rare and the fallback fires whenever the status
    badge fails to render. An *explicitly observed* status label IS allowed
    to transition away from a terminal state (Выкуп→Возврат is legitimate).

    Logs every suppressed downgrade so parser drift is observable in
    journalctl rather than silently absorbed.
    """
    conn = get_connection()
    try:
        if new_status == "Заказ":
            cur = conn.execute(
                "UPDATE orders SET status = ? WHERE key = ? AND status NOT IN (?, ?, ?)",
                (new_status, key, *TERMINAL_STATUSES),
            )
            conn.commit()
            if cur.rowcount == 0:
                # Distinguish "key absent" (caller bug) from "guard fired" (UI drift)
                # so the silent-but-logged guard is observable while a real bug surfaces.
                row = conn.execute(
                    "SELECT status FROM orders WHERE key = ?", (key,)
                ).fetchone()
                if row is not None and row["status"] in TERMINAL_STATUSES:
                    print(f"[status] suppressed downgrade {row['status']}→Заказ for key={key}")
            return cur.rowcount > 0
        cur = conn.execute(
            "UPDATE orders SET status = ? WHERE key = ?",
            (new_status, key),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def soft_delete_order(key, reason):
    """Mark a live row stale and rename its key so the original key is free
    to be re-inserted as a fresh row when the order reappears on the phone.

    The unique-key constraint forces the rename: without it, a re-appearance
    after soft-delete would hit IntegrityError in upsert_order. The renamed
    key (`STALE:<id>:<original>`) preserves forensic lookup — the original
    is recoverable by stripping the prefix.

    Returns True iff a row was updated. Idempotent on already-stale rows
    (returns False — they were renamed on the first soft-delete).
    """
    if not reason:
        raise ValueError("soft_delete_order requires a reason for audit.")
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM orders WHERE key = ? AND is_stale = 0", (key,)
        ).fetchone()
        if row is None:
            return False
        new_key = f"STALE:{row['id']}:{key}"
        conn.execute(
            "UPDATE orders SET is_stale = 1, stale_at = ?, stale_reason = ?, key = ? "
            "WHERE id = ?",
            (now_iso, reason, new_key, row["id"]),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def get_live_keys_in_range(start_iso, end_iso):
    """Return [(key, article, date_parsed, warehouse, arrival_city, price_cents), ...]
    for live rows whose date_parsed falls in [start_iso, end_iso).

    Used by the reconcile pass to bucket DB rows the same way phone-visible
    cards are bucketed (article, date_parsed, warehouse, arrival_city,
    price_cents) and detect divergence per bucket.
    """
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT key, article, date_parsed, warehouse, arrival_city, price_cents "
            "FROM orders "
            "WHERE is_stale = 0 AND date_parsed >= ? AND date_parsed < ?",
            (start_iso, end_iso),
        ).fetchall()
        return [
            (r["key"], r["article"], r["date_parsed"], r["warehouse"],
             r["arrival_city"], r["price_cents"])
            for r in rows
        ]
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
        today = datetime.now().strftime("%Y-%m-%d")
        today_count = conn.execute(
            "SELECT count(*) as c FROM orders WHERE first_seen >= ?", (today,)
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

    Args:
        start_dt: datetime string (e.g. '2026-04-05 00:00:00')
        end_dt: datetime string (e.g. '2026-04-05 23:59:59')

    Returns dict with count, revenue_cents, by_status list.
    """
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT count(*) as cnt, coalesce(sum(price_cents), 0) as rev "
            "FROM orders WHERE first_seen >= ? AND first_seen <= ?",
            (start_dt, end_dt),
        ).fetchone()
        by_status = conn.execute(
            "SELECT status, count(*) as cnt, coalesce(sum(price_cents), 0) as rev "
            "FROM orders WHERE first_seen >= ? AND first_seen <= ? "
            "GROUP BY status ORDER BY cnt DESC",
            (start_dt, end_dt),
        ).fetchall()
        return {
            "count": row["cnt"],
            "revenue_cents": row["rev"],
            "by_status": [(r["status"], r["cnt"], r["rev"]) for r in by_status],
        }
    finally:
        conn.close()


def get_totals_by_article(start_dt, end_dt):
    """Get order count and revenue grouped by article for a time range."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT article, vendor_code, count(*) as cnt, coalesce(sum(price_cents), 0) as rev "
            "FROM orders WHERE first_seen >= ? AND first_seen <= ? "
            "GROUP BY article ORDER BY cnt DESC",
            (start_dt, end_dt),
        ).fetchall()
        return [(r["article"], r["vendor_code"] or "", r["cnt"], r["rev"]) for r in rows]
    finally:
        conn.close()


# -------- Pending Telegram queue --------
# Used by wb_order_monitor.send_telegram when a send gives up (network outage,
# 429 budget exhausted). Messages are replayed at the top of each monitor cycle.

def enqueue_pending_telegram(text, last_error=None):
    """Append a message to the pending queue. Prunes oldest rows if over cap."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_connection()
    try:
        conn.execute(
            "INSERT INTO pending_telegram (created_at, text, last_error) VALUES (?, ?, ?)",
            (now, text, last_error),
        )
        conn.commit()
        # Prune oldest if we exceed the cap
        count = conn.execute("SELECT count(*) FROM pending_telegram").fetchone()[0]
        if count > PENDING_TG_MAX_ROWS:
            excess = count - PENDING_TG_MAX_ROWS
            conn.execute(
                "DELETE FROM pending_telegram WHERE id IN "
                "(SELECT id FROM pending_telegram ORDER BY id ASC LIMIT ?)",
                (excess,),
            )
            conn.commit()
            print(f"  pending_telegram: pruned {excess} oldest rows (cap {PENDING_TG_MAX_ROWS})")
    finally:
        conn.close()


def list_pending_telegram(limit=20):
    """Oldest-first slice of the pending queue."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT id, created_at, text, attempts, last_error "
            "FROM pending_telegram ORDER BY id ASC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_pending_telegram(row_id):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM pending_telegram WHERE id = ?", (row_id,))
        conn.commit()
    finally:
        conn.close()


def bump_pending_telegram_attempts(row_id, last_error=None):
    """Increment attempts counter; delete row if it exceeds PENDING_TG_MAX_ATTEMPTS."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT attempts FROM pending_telegram WHERE id = ?", (row_id,)
        ).fetchone()
        if row is None:
            return False  # already gone
        attempts = row["attempts"] + 1
        if attempts >= PENDING_TG_MAX_ATTEMPTS:
            conn.execute("DELETE FROM pending_telegram WHERE id = ?", (row_id,))
            conn.commit()
            print(f"  pending_telegram: dropped row {row_id} after {attempts} attempts "
                  f"(last_error={last_error!r})")
            return False
        conn.execute(
            "UPDATE pending_telegram SET attempts = ?, last_error = ? WHERE id = ?",
            (attempts, last_error, row_id),
        )
        conn.commit()
        return True
    finally:
        conn.close()
