"""Tests that get_totals* filter on date_parsed, not first_seen.

Uses a temp SQLite DB to avoid touching the real orders.db.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Point db.py at a temp file BEFORE importing it.
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()

import db  # noqa: E402
db.DB_PATH = _tmp.name
db.init_db()


def _insert(key, article, date_parsed_iso, first_seen, status="Заказ", price_cents=10000):
    conn = db.get_connection()
    conn.execute(
        """INSERT INTO orders
           (key, article, product, size, quantity, status, date_raw, date_parsed,
            price, price_cents, vendor_code, category, warehouse, arrival_city, first_seen)
           VALUES (?, ?, '', '', '', ?, '', ?, '', ?, '', '', '', '', ?)""",
        (key, article, status, date_parsed_iso, price_cents, first_seen),
    )
    conn.commit()
    conn.close()


def _wipe():
    conn = db.get_connection()
    conn.execute("DELETE FROM orders")
    conn.commit()
    conn.close()


def test_get_totals_uses_date_parsed_not_first_seen():
    _wipe()
    # Order placed on 2026-04-07 at 23:00, but the scraper saw it at 2026-04-08 03:00
    # (e.g. came back online after a 4-hour outage). A query for 2026-04-07 should
    # find this order.
    _insert("k1", "111", "2026-04-07T23:00:00", "2026-04-08 03:00:00")
    totals = db.get_totals("2026-04-07 00:00:00", "2026-04-07 23:59:59")
    assert totals["count"] == 1, f"expected 1, got {totals['count']}"


def test_get_totals_excludes_orders_outside_window():
    _wipe()
    _insert("k2", "222", "2026-04-05T12:00:00", "2026-04-05 12:01:00")
    totals = db.get_totals("2026-04-07 00:00:00", "2026-04-07 23:59:59")
    assert totals["count"] == 0


def test_get_totals_by_article_uses_date_parsed():
    _wipe()
    _insert("k3", "333", "2026-04-07T10:00:00", "2026-04-08 00:00:00")
    _insert("k4", "333", "2026-04-07T11:00:00", "2026-04-08 00:00:00")
    rows = db.get_totals_by_article("2026-04-07 00:00:00", "2026-04-07 23:59:59")
    assert len(rows) == 1
    assert rows[0][0] == "333"
    assert rows[0][2] == 2  # cnt


def test_get_stats_today_uses_date_parsed():
    _wipe()
    # Insert an order whose date_parsed is today's midnight or later
    # Use a wide-enough fake "today" by inserting something dated now
    from datetime import datetime
    today_iso = datetime.now().strftime("%Y-%m-%dT12:00:00")
    _insert("k5", "444", today_iso, "2099-01-01 00:00:00")  # first_seen deliberately in the future
    stats = db.get_stats()
    assert stats["today"] >= 1, f"expected today >= 1, got {stats['today']}"


if __name__ == "__main__":
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                print(f"FAIL  {name}: {e}")
                failures += 1
    os.unlink(_tmp.name)
    sys.exit(1 if failures else 0)
