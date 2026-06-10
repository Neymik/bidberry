#!/usr/bin/env python3
"""Export order data from orders.db to a Google Sheet (Заказ only, overwrite).

Pushes a daily x product summary of orders PLACED (status='Заказ') — the
manager's metric — overwriting the target worksheet each run so it is always
current. Buyouts/refusals/returns are intentionally excluded.

Importable: wb_order_monitor's sheets_export job calls export() periodically;
running the file directly does the same once.
"""
import os
import sqlite3

import gspread
from google.oauth2.service_account import Credentials

try:  # standalone runs pick up WB_TZ_SHIFT_HOURS from .env like the monitor does
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "orders.db")
KEY = os.path.join(HERE, "gsheets-key.json")
SHEET_ID = "1T0YjtkHe0L6ylFdLgzPKZqMtWGo-PzXLy3TK_ionnCU"
TAB = "Заказы"
SINCE = "2026-06-01"


def _msk_expr():
    # orders.db stores order times in the capturing device's timezone, because the WB
    # app renders 'Дата оформления' in device-local time. The local emulator runs
    # Asia/Tokyo (MSK+6), so we shift -6h to MSK. On a host where orders.db is already
    # MSK (the production server whose phone is MSK), set WB_TZ_SHIFT_HOURS=0.
    # Read at call time so the monitor's load_dotenv() is honored regardless of
    # import order.
    shift = os.environ.get("WB_TZ_SHIFT_HOURS", "-6")
    return f"datetime(date_parsed, '{shift} hours')"


def authorize():
    creds = Credentials.from_service_account_file(
        KEY, scopes=["https://www.googleapis.com/auth/spreadsheets"])
    return gspread.authorize(creds)


def export(gc=None):
    """Build the summary and overwrite the tab. Returns the row count written."""
    msk = _msk_expr()
    sql = f"""
    SELECT substr({msk}, 1, 10)                     AS day,
           COALESCE(vendor_code, '?')               AS product_code,
           MAX(article)                             AS article,
           MAX(product)                             AS product_name,
           COUNT(*)                                 AS orders_placed,
           printf('%.0f', SUM(price_cents) / 100.0) AS revenue_rub
    FROM orders
    WHERE status = 'Заказ' AND substr({msk}, 1, 10) >= ?
    GROUP BY day, product_code
    ORDER BY day, orders_placed DESC;
    """
    con = sqlite3.connect(DB)
    try:
        rows = con.execute(sql, (SINCE,)).fetchall()
    finally:
        con.close()
    header = ["day", "product_code", "article", "product_name", "orders_placed", "revenue_rub"]
    values = [header] + [list(r) for r in rows]

    if gc is None:
        gc = authorize()
    sh = gc.open_by_key(SHEET_ID)
    try:
        ws = sh.worksheet(TAB)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(TAB, rows=max(1000, len(values) + 10), cols=10)
    ws.clear()
    ws.update(range_name="A1", values=values, value_input_option="RAW")
    print(f"Wrote {len(rows)} rows to tab '{TAB}' in sheet {SHEET_ID}")
    return len(rows)


def main():
    export()


if __name__ == "__main__":
    main()
