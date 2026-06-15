"""Unit tests for db.soft_delete_order and the live-key filtering it gates.

Run: ./venv/bin/python3 test_soft_delete.py
"""

import os
import tempfile
import unittest
from unittest.mock import patch

import db


class TestSoftDelete(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmpdir, "test_orders.db")
        self._patcher = patch.object(db, "DB_PATH", self.db_path)
        self._patcher.start()
        db.init_db()

    def tearDown(self):
        self._patcher.stop()
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
        os.rmdir(self.tmpdir)

    def _insert(self, key, status="Заказ"):
        order = {
            "key": key,
            "article": "777",
            "size": "L",
            "quantity": "1 шт",
            "status": status,
            "date": "27 апр, 23:36",
            "price": "2493 ₽",
            "vendor_code": "VC",
            "warehouse": "W",
            "arrival_city": "C",
        }
        self.assertTrue(db.upsert_order(order), f"upsert failed for {key}")

    def test_soft_delete_marks_stale_and_renames_key(self):
        self._insert("k1")
        self.assertTrue(db.soft_delete_order("k1", "test"))

        # The original key is no longer in get_all_keys (live set).
        self.assertNotIn("k1", db.get_all_keys())
        self.assertNotIn("k1", db.get_key_status_map())

        # The renamed key carries STALE: prefix + the original.
        conn = db.get_connection()
        try:
            row = conn.execute(
                "SELECT key, is_stale, stale_reason FROM orders WHERE article='777'"
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(row["is_stale"], 1)
        self.assertEqual(row["stale_reason"], "test")
        self.assertTrue(row["key"].startswith("STALE:"))
        self.assertTrue(row["key"].endswith(":k1"))

    def test_soft_delete_then_reinsert_creates_fresh_row(self):
        # The soft-delete-then-reappear flow: rename frees the original key
        # so upsert_order can insert a fresh row.
        self._insert("k1")
        db.soft_delete_order("k1", "reconcile_recent_missing")
        self._insert("k1")  # re-insert with the same key
        self.assertIn("k1", db.get_all_keys())
        # Both rows survive: the renamed stale one + the fresh live one.
        conn = db.get_connection()
        try:
            cnt = conn.execute(
                "SELECT count(*) c FROM orders WHERE article='777'"
            ).fetchone()["c"]
        finally:
            conn.close()
        self.assertEqual(cnt, 2)

    def test_soft_delete_returns_false_on_missing_key(self):
        self.assertFalse(db.soft_delete_order("nonexistent", "test"))

    def test_soft_delete_idempotent_on_already_stale(self):
        # Once a row is stale, its key was renamed; calling soft_delete with
        # the original key again finds no live row and returns False.
        self._insert("k1")
        self.assertTrue(db.soft_delete_order("k1", "first"))
        self.assertFalse(db.soft_delete_order("k1", "second"))

    def test_get_live_keys_in_range_excludes_stale(self):
        self._insert("live_key")
        self._insert("dead_key")
        db.soft_delete_order("dead_key", "test")
        rows = db.get_live_keys_in_range("2026-04-27T00:00:00", "2026-04-28T00:00:00")
        keys = [r[0] for r in rows]
        self.assertIn("live_key", keys)
        self.assertNotIn("dead_key", keys)
        # The renamed dead row shouldn't sneak in either.
        self.assertFalse(any(k.startswith("STALE:") for k in keys))

    def test_soft_delete_requires_reason(self):
        self._insert("k1")
        with self.assertRaises(ValueError):
            db.soft_delete_order("k1", "")
        with self.assertRaises(ValueError):
            db.soft_delete_order("k1", None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
