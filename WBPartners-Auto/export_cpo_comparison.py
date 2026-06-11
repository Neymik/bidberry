#!/usr/bin/env python3
"""Compare bot-scraped orders (orders.db) vs the manual 'Расчет CPO' sheet, with CPO.

For each day x product (Штаны: grey/black), pulls the manual orders/spend/CPO from
the 'Расчет CPO' sheet, counts our orders placed (status='Заказ') over the SAME window
(весь день = full day, otherwise up to the manual checkpoint time), and computes our
CPO = manual_spend / our_orders. Writes the table to a tab in the bidberry sheet.

РК column = the product's WB article (nmID).

Importable: wb_order_monitor's sheets_export job calls export() periodically;
running the file directly does the same once.
"""
import os
import re
import sqlite3

import gspread
from google.oauth2.service_account import Credentials

try:  # standalone runs pick up WB_TZ_SHIFT_HOURS from .env like the monitor does
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = os.path.join(HERE, "gsheets-key.json")
DB = os.path.join(HERE, "orders.db")
MANUAL_ID = "18A79mif7NdZU3h95FiGrjAO1zyd1iWUQDzibck2kRNQ"
OUT_ID = "1T0YjtkHe0L6ylFdLgzPKZqMtWGo-PzXLy3TK_ionnCU"
OUT_TAB = "Сравнение CPO"
SINCE = "2026-06-01"  # only show days from this date (ISO), matching the Заказы tab

# product -> (manual label, vendor_code). Columns in the manual 'Штаны' tab:
#   grey:  время=1 заказы=2 затраты=3 CPO=4   |   black: время=7 заказы=8 затраты=9 CPO=10
PRODUCTS = [
    ("штаны серые женские", "БркФтр2Млнж", (1, 2, 3, 4)),
    ("штаны черные женские", "БркФтр2Чрн", (7, 8, 9, 10)),
]


def num(s):
    s = re.sub(r"[^\d]", "", s or "")
    return int(s) if s else None


def iso(d):  # 01.06.26 -> 2026-06-01
    dd, mm, yy = d.split(".")
    return f"20{yy}-{mm}-{dd}"


def parse_manual(ws):
    """Return {(date_iso, label): {orders, spend, cpo, t}} using the last row per
    day/product (= весь день when present, else the latest checkpoint)."""
    vals = ws.get_all_values()
    out, cur = {}, None
    for row in vals[4:]:
        row = row + [""] * (13 - len(row))
        a = row[0].strip()
        if re.match(r"\d{2}\.\d{2}\.\d{2}", a):
            cur = iso(a)
        if not cur:
            continue
        for label, _vc, (ti, oi, si, ci) in PRODUCTS:
            t = row[ti].strip()
            o = num(row[oi])
            if not t or o is None:
                continue
            out[(cur, label)] = {"orders": o, "spend": num(row[si]), "cpo": num(row[ci]), "t": t}
    return out


def _msk_expr():
    # orders.db times are in the capturing device TZ (local emulator = Asia/Tokyo =
    # MSK+6); the manual sheet is MSK. Shift to MSK before matching the manual
    # day/checkpoint. On a host where orders.db is already MSK (production server /
    # MSK phone) set WB_TZ_SHIFT_HOURS=0. Read at call time so the monitor's
    # load_dotenv() is honored regardless of import order.
    shift = os.environ.get("WB_TZ_SHIFT_HOURS", "-6")
    return f"datetime(date_parsed, '{shift} hours')"


def our_orders(con, msk, vc, date, tlabel):
    q = (f"SELECT COUNT(*) FROM orders WHERE vendor_code=? AND substr({msk},1,10)=? "
         "AND status='Заказ'")
    p = [vc, date]
    if tlabel != "весь день" and re.match(r"\d{1,2}:\d{2}", tlabel):
        q += f" AND substr({msk},12,5)<=?"
        p.append(tlabel)
    return con.execute(q, p).fetchone()[0]


def authorize():
    creds = Credentials.from_service_account_file(
        KEY, scopes=["https://www.googleapis.com/auth/spreadsheets"])
    return gspread.authorize(creds)


def export(gc=None):
    """Rebuild the comparison and overwrite the tab. Returns the row count written."""
    msk = _msk_expr()
    if gc is None:
        gc = authorize()
    manual = parse_manual(gc.open_by_key(MANUAL_ID).worksheet("Штаны"))

    con = sqlite3.connect(DB)
    try:
        art = {vc: (con.execute(
            "SELECT article FROM orders WHERE vendor_code=? ORDER BY date_parsed DESC LIMIT 1",
            (vc,)).fetchone() or [""])[0] for _l, vc, _c in PRODUCTS}
        vc_of = {label: vc for label, vc, _c in PRODUCTS}

        header = ["Дата", "Товар", "РК", "Период", "Заказы (ручной)", "Заказы (бот)",
                  "Δ заказы", "Δ заказы %", "Затраты ₽", "CPO (ручной)", "CPO (бот)",
                  "Δ CPO", "Δ CPO %"]
        # Full picture: union every (day, product) the bot recorded Заказы for with the
        # days present in the manual sheet. Days the manager hasn't filled in still appear
        # — manual & CPO columns blank, showing the bot's order count for the whole day.
        # Bounded below by SINCE so the tab stays focused on the current period.
        keys = {k for k in manual if k[0] >= SINCE}
        for label, vc, _c in PRODUCTS:
            for (d,) in con.execute(
                    f"SELECT DISTINCT substr({msk}, 1, 10) FROM orders "
                    "WHERE vendor_code=? AND status='Заказ' "
                    f"AND substr({msk}, 1, 10) >= ?", (vc, SINCE)):
                if d:
                    keys.add((d, label))

        rows = []
        for (date, label) in sorted(keys):
            vc = vc_of[label]
            m = manual.get((date, label))
            if not m:
                n = our_orders(con, msk, vc, date, "весь день")
                rows.append([date, label, str(art[vc]), "весь день", "", n,
                             "", "", "", "", "", "", ""])
                continue
            n = our_orders(con, msk, vc, date, m["t"])
            our_cpo = round(m["spend"] / n) if (m["spend"] and n) else ""
            d_ord = n - m["orders"]
            d_cpo = (our_cpo - m["cpo"]) if (our_cpo != "" and m["cpo"]) else ""
            d_ord_pct = f"{d_ord / m['orders'] * 100:+.1f}%" if m["orders"] else ""
            d_cpo_pct = f"{(our_cpo - m['cpo']) / m['cpo'] * 100:+.1f}%" if (our_cpo != "" and m["cpo"]) else ""
            win = "весь день" if m["t"] == "весь день" else f"≤{m['t']}"
            rows.append([date, label, str(art[vc]), win, m["orders"], n, d_ord, d_ord_pct,
                         m["spend"], m["cpo"], our_cpo, d_cpo, d_cpo_pct])
    finally:
        con.close()

    values = [header] + rows
    sh = gc.open_by_key(OUT_ID)
    try:
        ws = sh.worksheet(OUT_TAB)
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(OUT_TAB, rows=max(200, len(values) + 10), cols=len(header) + 2)
    ws.clear()
    ws.update(range_name="A1", values=values, value_input_option="RAW")
    print(f"Wrote {len(rows)} comparison rows to '{OUT_TAB}'")
    return len(rows)


def main():
    export()


if __name__ == "__main__":
    main()
