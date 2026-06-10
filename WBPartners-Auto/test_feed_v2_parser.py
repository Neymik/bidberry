"""Unit tests for ui.feed_v2.parse_orders against a real 2.34.0 feed dump.

The fixture (tests/fixtures/feed_2_34.xml) was captured on the production phone
on 2026-06-10. Its visible cards:
  1. 391662797/БркФтр2Чрн XS — placed 10 июн 10:48, status date 10 июн 10:48
  2. 336624719/БркФтр2Млнж S — placed 9 июн 09:24, status date 10 июн 10:45
     (the probe card for status-date-vs-order-date confusion)
  3. a partially rendered card (no status/dates/price) that must be dropped

Run: ./venv/bin/python3 test_feed_v2_parser.py
"""

import os
import unittest

from db import build_key
from ui.feed_v2 import parse_orders

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "tests", "fixtures", "feed_2_34.xml")


def load_fixture():
    with open(FIXTURE, encoding="utf-8") as f:
        return f.read()


class TestParseOrdersV2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.orders = parse_orders(load_fixture())

    def test_complete_cards_parsed_partial_dropped(self):
        # 3 cards in the dump; the third is cropped (no status/dates/price).
        self.assertEqual(len(self.orders), 2)

    def test_first_card_fields(self):
        o = self.orders[0]
        self.assertEqual(o["article"], "391662797")
        self.assertEqual(o["vendor_code"], "БркФтр2Чрн")
        self.assertEqual(o["size"], "XS")
        self.assertEqual(o["quantity"], "1 шт")
        self.assertEqual(o["status"], "Заказ")
        self.assertEqual(o["date"], "10 июн, 10:48")
        self.assertEqual(o["price"], "2\xa0450\xa0₽")
        self.assertEqual(o["arrival_city"], "Москва")
        self.assertEqual(o["warehouse"], "Электросталь")
        self.assertEqual(o["category"], "Брюки спортивные")
        self.assertTrue(o["product"].startswith("Спортивные штаны"))

    def test_status_date_captured_but_never_the_order_date(self):
        # Card 2 is the probe: order date and status date differ by a day.
        o = self.orders[1]
        self.assertEqual(o["date"], "9 июн, 09:24")          # Дата оформления
        self.assertEqual(o["status_date"], "10 июн, 10:45")  # Дата текущего статуса
        self.assertNotEqual(o["date"], o["status_date"])

    def test_key_uses_order_date_and_matches_v1_formula(self):
        # Keys must stay DB-compatible: build_key over the parsed fields,
        # with the ORDER date (not status date) inside.
        for o in self.orders:
            expected = build_key({k: v for k, v in o.items()
                                  if k not in ("key", "status_date", "category")})
            self.assertEqual(o["key"], expected)
        self.assertIn("-06-09T09:24", self.orders[1]["key"])
        self.assertNotIn("10:45", self.orders[1]["key"])

    def test_status_from_badge_node(self):
        # Status is read from the wb_tag_text badge on 2.34.
        self.assertEqual({o["status"] for o in self.orders}, {"Заказ"})

    def test_error_screen_returns_empty(self):
        self.assertEqual(parse_orders("<hierarchy>Что-то пошло не так</hierarchy>"), [])
        self.assertEqual(parse_orders(""), [])


if __name__ == "__main__":
    unittest.main()
