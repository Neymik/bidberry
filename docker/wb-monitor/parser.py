"""
WB Partners order feed parser.
Extracts order cards from uiautomator2 XML hierarchy dump.
"""

import re
from xml.etree import ElementTree

# Russian month substrings used for date detection
_MONTH_FRAGMENTS = (
    "янв", "фев", "мар", "апр", "май", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек",
)

# Known order statuses
_STATUSES = {"Заказ", "Отказ", "Выкуп", "Возврат"}

# Minimum text nodes for a card to be considered valid
_MIN_TEXTS = 5

# Required fields — skip partially rendered cards
_REQUIRED_FIELDS = ("article", "status", "date_raw", "price")


def _looks_like_date(text: str) -> bool:
    """Check if text looks like a WB date string, e.g. '9 мар, 19:05'."""
    if ":" not in text:
        return False
    return any(m in text.lower() for m in _MONTH_FRAGMENTS)


def _price_to_cents(price_str: str) -> int:
    """Extract numeric value from price string and convert to cents.
    '1 234 ₽' -> 123400, '99,50 ₽' -> 9950
    """
    cleaned = re.sub(r"[^\d,.]", "", price_str)
    if not cleaned:
        return 0
    # Handle comma as decimal separator
    if "," in cleaned:
        parts = cleaned.split(",")
        integer_part = parts[0].replace(".", "")
        decimal_part = parts[1][:2] if len(parts) > 1 else "00"
        decimal_part = decimal_part.ljust(2, "0")
        return int(integer_part) * 100 + int(decimal_part)
    # No decimal — whole rubles
    cleaned = cleaned.replace(".", "")
    return int(cleaned) * 100 if cleaned else 0


def parse_orders(xml_text: str) -> list[dict]:
    """Parse order cards from uiautomator2 dump_hierarchy() XML.

    Returns a list of order dicts with keys:
        article, product, size, quantity, status, price, price_cents,
        date_raw, category, warehouse, arrival_city, dedup_key
    """
    root = ElementTree.fromstring(xml_text)

    # Find the scrollable container from wb.partners
    scrollable = None
    for node in root.iter():
        if (
            node.get("scrollable") == "true"
            and node.get("package") == "wb.partners"
        ):
            scrollable = node
            break

    if scrollable is None:
        return []

    orders: list[dict] = []

    for card in scrollable:
        texts: list[str] = []
        text_with_ids: list[tuple[str, str]] = []

        for node in card.iter():
            text = (node.get("text") or "").strip()
            rid = node.get("resource-id", "")
            if text:
                texts.append(text)
                text_with_ids.append((text, rid))

        if len(texts) < _MIN_TEXTS:
            continue

        order: dict = {}
        # First text node is typically the product name
        order["product"] = texts[0]

        for text, rid in text_with_ids:
            # Status via resource-id tag
            if rid == "wb_tag_text" or text in _STATUSES:
                order["status"] = text
            # Article number: 5-15 digit string
            elif text.isdigit() and 5 <= len(text) <= 15:
                order["article"] = text
            # Size field
            elif text.startswith("Размер"):
                order["size"] = text.replace("Размер ", "")
            # Quantity field (contains "шт")
            elif "шт" in text and len(text) < 10:
                order["quantity"] = text
            # Price field (contains ₽)
            elif "₽" in text:
                order["price"] = text
            # Date field
            elif _looks_like_date(text):
                order["date_raw"] = text

        # Check required fields
        missing = [f for f in _REQUIRED_FIELDS if not order.get(f)]
        if missing:
            continue

        # Extract warehouse and arrival city
        all_texts = [t for t, _ in text_with_ids]
        for i, t in enumerate(all_texts):
            if t == "Прибытие" and i + 1 < len(all_texts):
                order["arrival_city"] = all_texts[i + 1]
            if t == "Склад WB" and i + 1 < len(all_texts):
                order["warehouse"] = all_texts[i + 1]

        # Extract category (known clothing categories)
        known_categories = {
            "Платья", "Футболки", "Юбки", "Брюки",
            "Куртки", "Рубашки", "Джинсы", "Шорты",
            "Блузки", "Костюмы", "Пальто", "Свитеры",
        }
        for t, _ in text_with_ids:
            if t in known_categories:
                order["category"] = t
                break

        # Compute derived fields
        order.setdefault("size", "")
        order.setdefault("quantity", "1 шт")
        order.setdefault("category", "")
        order.setdefault("warehouse", "")
        order.setdefault("arrival_city", "")
        order["price_cents"] = _price_to_cents(order["price"])
        order["dedup_key"] = (
            f"{order['article']}|{order.get('size', '')}|"
            f"{order['status']}|{order['date_raw']}"
        )

        orders.append(order)

    return orders
