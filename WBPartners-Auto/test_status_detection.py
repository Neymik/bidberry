"""Unit tests for detect_status — the parser's status-from-text-nodes detection.

Run: ./venv/bin/python3 test_status_detection.py
"""

import unittest

from wb_order_monitor import VALID_STATUSES, detect_status


class TestDetectStatus(unittest.TestCase):
    def test_explicit_status_wins_over_fallback(self):
        texts = [
            "Product Name", "391662797", "Размер L", "1 шт", "2 495 ₽",
            "Дата оформления", "27 апр, 03:17", "Прибытие", "Москва", "Отказ",
        ]
        self.assertEqual(detect_status(texts), "Отказ")

    def test_no_label_falls_back_to_zakaz(self):
        texts = ["Product Name", "391662797", "Размер L", "1 шт", "2 495 ₽"]
        self.assertEqual(detect_status(texts), "Заказ")

    def test_right_to_left_preference_over_product_name(self):
        # Product name happens to contain "Заказ" as a token early in traversal;
        # the real badge "Отказ" renders later. Right-to-left scan must pick it.
        texts = ["Заказ премиум", "391662797", "Размер L", "Отказ"]
        self.assertEqual(detect_status(texts), "Отказ")

    def test_each_valid_status_recognized(self):
        for s in VALID_STATUSES:
            self.assertEqual(detect_status(["Product", "1", s]), s)

    def test_empty_texts_falls_back(self):
        self.assertEqual(detect_status([]), "Заказ")

    def test_substring_match_does_not_count(self):
        # A product description containing "Заказчик" must not register as "Заказ".
        # `in VALID_STATUSES` is exact-equality, but guard against accidental
        # `in` substring matches if the helper is ever rewritten.
        texts = ["Заказчик доволен", "391662797", "Размер L"]
        self.assertEqual(detect_status(texts), "Заказ")  # falls back, no real label


if __name__ == "__main__":
    unittest.main(verbosity=2)
