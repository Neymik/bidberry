"""Unit tests for db.build_key() — the dedup key formula.

Run: ./venv/bin/python3 test_build_key.py
"""

import unittest

from db import build_key


class TestBuildKey(unittest.TestCase):
    def test_canonical(self):
        """Sample seller order from the plan renders exactly as expected."""
        order = {
            "article": "391662797",
            "vendor_code": "БркФтр2Чрн",
            "size": "L",
            "quantity": "1 шт",
            "price": "2 495 ₽",
            "date": "17 апр, 23:21",
            "arrival_city": "рабочий посёлок Лопатино",
            "warehouse": "Коледино",
        }
        # date parses using current year (see db.parse_russian_date). We don't
        # pin the year here — just verify shape + non-year components.
        key = build_key(order)
        parts = key.split("#")
        self.assertEqual(parts[0], "БркФтр2Чрн")
        self.assertEqual(parts[1], "L")
        self.assertEqual(parts[2], "1")
        self.assertEqual(parts[3], "2495")
        self.assertTrue(parts[4].endswith("T23:21:00"), f"date_iso shape: {parts[4]}")
        self.assertEqual(parts[5], "рабочий посёлок Лопатино")
        self.assertEqual(parts[6], "Коледино")

    def test_vendor_code_missing_falls_back_to_article(self):
        order = {
            "article": "391662797",
            "size": "M",
            "quantity": "1 шт",
            "price": "100 ₽",
            "date": "17 апр, 10:00",
            "arrival_city": "Москва",
            "warehouse": "Коледино",
        }
        key = build_key(order)
        self.assertTrue(key.startswith("A:391662797#"), key)

    def test_all_identifiers_missing_produces_empty_prefix_no_crash(self):
        order = {
            "size": "S",
            "quantity": "1 шт",
            "price": "50 ₽",
            "date": "17 апр, 10:00",
            "arrival_city": "Москва",
            "warehouse": "Коледино",
        }
        key = build_key(order)
        # Empty leading segment, then #-joined remaining parts; must not crash.
        self.assertTrue(key.startswith("#S#1#50#"), key)

    def test_parse_russian_date_none_falls_back_to_raw(self):
        order = {
            "article": "123456",
            "vendor_code": "X",
            "size": "",
            "quantity": "1 шт",
            "price": "100 ₽",
            "date": "garbage-date",
            "arrival_city": "Москва",
            "warehouse": "W",
        }
        key = build_key(order)
        parts = key.split("#")
        self.assertEqual(parts[4], "garbage-date")

    def test_missing_date_entirely(self):
        order = {
            "article": "123456",
            "vendor_code": "X",
            "size": "",
            "quantity": "1 шт",
            "price": "100 ₽",
            "arrival_city": "Москва",
            "warehouse": "W",
        }
        key = build_key(order)
        parts = key.split("#")
        self.assertEqual(parts[4], "")

    def test_hash_in_input_is_stripped(self):
        order = {
            "article": "1",
            "vendor_code": "A#B",
            "size": "L#XL",
            "quantity": "1 шт",
            "price": "100 ₽",
            "date": "17 апр, 10:00",
            "arrival_city": "City#1",
            "warehouse": "W#H",
        }
        key = build_key(order)
        # Must have exactly 6 separators (7 fields)
        self.assertEqual(key.count("#"), 6, f"separator count in {key!r}")
        parts = key.split("#")
        self.assertEqual(parts[0], "AB")
        self.assertEqual(parts[1], "LXL")
        self.assertEqual(parts[5], "City1")
        self.assertEqual(parts[6], "WH")

    def test_cyrillic_city(self):
        order = {
            "article": "1",
            "vendor_code": "X",
            "size": "L",
            "quantity": "1 шт",
            "price": "100 ₽",
            "date": "17 апр, 10:00",
            "arrival_city": "рабочий посёлок Лопатино",
            "warehouse": "Коледино",
        }
        key = build_key(order)
        self.assertIn("рабочий посёлок Лопатино", key)
        self.assertIn("Коледино", key)

    def test_db_row_shape_uses_pre_parsed_fields(self):
        """When called on a DB row (date_parsed + price_cents already computed), use those."""
        db_row = {
            "article": "391662797",
            "vendor_code": "БркФтр2Чрн",
            "size": "L",
            "quantity": "1 шт",
            "price_cents": 249500,
            "date_parsed": "2026-04-17T23:21:00",
            "arrival_city": "рабочий посёлок Лопатино",
            "warehouse": "Коледино",
        }
        key = build_key(db_row)
        parts = key.split("#")
        self.assertEqual(parts[3], "2495")
        self.assertEqual(parts[4], "2026-04-17T23:21:00")

    def test_quantity_numeric_only(self):
        order = {
            "article": "1",
            "vendor_code": "X",
            "size": "L",
            "quantity": "42 шт",
            "price": "100 ₽",
            "date": "17 апр, 10:00",
            "arrival_city": "A",
            "warehouse": "B",
        }
        parts = build_key(order).split("#")
        self.assertEqual(parts[2], "42")

    def test_price_zero_when_missing(self):
        order = {
            "article": "1",
            "vendor_code": "X",
            "size": "L",
            "quantity": "1 шт",
            "date": "17 апр, 10:00",
            "arrival_city": "A",
            "warehouse": "B",
        }
        parts = build_key(order).split("#")
        self.assertEqual(parts[3], "")

    def test_distinct_orders_same_minute_produce_distinct_keys(self):
        """The whole point: same article+size+date but different price → different keys."""
        base = {
            "article": "391662797",
            "vendor_code": "БркФтр2Чрн",
            "size": "L",
            "quantity": "1 шт",
            "date": "17 апр, 14:23",
            "arrival_city": "Москва",
            "warehouse": "Коледино",
        }
        k1 = build_key({**base, "price": "2 495 ₽"})
        k2 = build_key({**base, "price": "2 545 ₽"})
        self.assertNotEqual(k1, k2)

    def test_truly_identical_orders_still_collide(self):
        """Accepted limitation: two identical orders in the same minute → same key."""
        order = {
            "article": "391662797",
            "vendor_code": "БркФтр2Чрн",
            "size": "L",
            "quantity": "1 шт",
            "price": "2 495 ₽",
            "date": "17 апр, 14:23",
            "arrival_city": "Москва",
            "warehouse": "Коледино",
        }
        self.assertEqual(build_key(order), build_key(order))


if __name__ == "__main__":
    unittest.main(verbosity=2)
