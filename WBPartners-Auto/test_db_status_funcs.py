"""Unit tests for db.get_key_status_map and db.update_order_status.

Run: ./venv/bin/python3 test_db_status_funcs.py
"""

import os
import tempfile
import unittest
from unittest.mock import patch

import db


class TestStatusFuncs(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmpdir, "test_orders.db")
        # Patch DB_PATH so init_db / connections target the temp file.
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
            "article": "1",
            "size": "L",
            "quantity": "1 шт",
            "status": status,
            "date": "17 апр, 10:00",
            "price": "100 ₽",
            "vendor_code": "X",
            "warehouse": "W",
            "arrival_city": "C",
        }
        self.assertTrue(db.upsert_order(order), "upsert_order failed for new key")

    # ------ get_key_status_map ------

    def test_get_key_status_map_empty_db(self):
        self.assertEqual(db.get_key_status_map(), {})

    def test_get_key_status_map_returns_dict_with_statuses(self):
        self._insert("k1", "Заказ")
        self._insert("k2", "Отказ")
        self._insert("k3", "Выкуп")
        self.assertEqual(
            db.get_key_status_map(),
            {"k1": "Заказ", "k2": "Отказ", "k3": "Выкуп"},
        )

    # ------ update_order_status: happy path ------

    def test_update_returns_true_on_hit(self):
        self._insert("k1", "Заказ")
        self.assertTrue(db.update_order_status("k1", "Отказ"))
        self.assertEqual(db.get_key_status_map()["k1"], "Отказ")

    def test_update_returns_false_on_missing_key(self):
        self.assertFalse(db.update_order_status("nonexistent-key", "Отказ"))

    # ------ Terminal-no-downgrade guard ------

    def test_terminal_no_downgrade_to_zakaz(self):
        # The parser fallback ("Заказ" when no label is found) must never
        # clobber an already-terminal status.
        self._insert("k1", "Отказ")
        self.assertFalse(db.update_order_status("k1", "Заказ"))
        self.assertEqual(db.get_key_status_map()["k1"], "Отказ")

    def test_terminal_no_downgrade_for_each_terminal_status(self):
        for terminal in ("Отказ", "Выкуп", "Возврат"):
            self._insert(f"k_{terminal}", terminal)
            self.assertFalse(
                db.update_order_status(f"k_{terminal}", "Заказ"),
                f"guard failed for {terminal}",
            )
            self.assertEqual(db.get_key_status_map()[f"k_{terminal}"], terminal)

    def test_terminal_to_terminal_via_explicit_label_allowed(self):
        # The guard only blocks the "Заказ" fallback. An explicitly observed
        # status label may transition between terminals (Выкуп → Возврат).
        self._insert("k1", "Выкуп")
        self.assertTrue(db.update_order_status("k1", "Возврат"))
        self.assertEqual(db.get_key_status_map()["k1"], "Возврат")

    def test_terminal_to_explicit_zakaz_not_special_case(self):
        # The guard fires on new_status == "Заказ" specifically because that's
        # the parser fallback. It does not fire when new_status is any other
        # value, so a Заказ ← Отказ transition through some other code path
        # would need the caller to distinguish "fallback" vs "observed". The
        # guard's contract is "no Отказ→Заказ downgrade", which we verify here.
        self._insert("k1", "Отказ")
        self.assertFalse(db.update_order_status("k1", "Заказ"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
