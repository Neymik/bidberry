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


def our_orders(con, msk, vc, date, tlabel, live=True):
    """Count the bot's orders for one day/product within the manual window.

    live=True  -> only orders currently in status 'Заказ' (current/live count, as the
                  manager sees pending orders right now; buyouts/refusals/returns drop out).
    live=False -> every order ever placed that day (= total rows), i.e. anything that was
                  at least once a 'Заказ' even if it has since moved to Выкуп/Отказ/Возврат.
                  We keep no status-history table, so total rows is the faithful proxy.

    The time window filters on order-placement time (date_parsed), so it applies
    identically to both counts.
    """
    q = f"SELECT COUNT(*) FROM orders WHERE vendor_code=? AND substr({msk},1,10)=?"
    p = [vc, date]
    if live:
        q += " AND status='Заказ'"
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

        # Two bot cross-sections per day/product:
        #   live = orders currently in 'Заказ' (pending right now)
        #   ever = every order ever placed that day (total rows; anything that was at least
        #          once a 'Заказ', incl. those since moved to Выкуп/Отказ/Возврат)
        # Each gets its own Δ vs the manual count and its own CPO = Затраты / count.
        header = ["Дата", "Товар", "РК", "Период", "Затраты ₽",
                  "Заказы (ручной)", "CPO (ручной)",
                  "Заказы live", "Δ live", "Δ live %", "CPO live", "Δ CPO live", "Δ CPO live %",
                  "Заказы ever", "Δ ever", "Δ ever %", "CPO ever", "Δ CPO ever", "Δ CPO ever %"]
        # Full picture: union every (day, product) the bot recorded ANY order for with the
        # days present in the manual sheet. Days the manager hasn't filled in still appear
        # — manual & CPO columns blank, showing the bot's order counts for the whole day.
        # Bounded below by SINCE so the tab stays focused on the current period.
        keys = {k for k in manual if k[0] >= SINCE}
        for label, vc, _c in PRODUCTS:
            for (d,) in con.execute(
                    f"SELECT DISTINCT substr({msk}, 1, 10) FROM orders "
                    "WHERE vendor_code=? "
                    f"AND substr({msk}, 1, 10) >= ?", (vc, SINCE)):
                if d:
                    keys.add((d, label))

        def cpo(spend, n):
            return round(spend / n) if (spend and n) else ""

        def d_abs(n, base):
            return (n - base) if base else ""

        def d_pct(n, base):
            return f"{(n - base) / base * 100:+.1f}%" if base else ""

        rows = []
        for (date, label) in sorted(keys):
            vc = vc_of[label]
            m = manual.get((date, label))
            tlabel = m["t"] if m else "весь день"
            n_live = our_orders(con, msk, vc, date, tlabel, live=True)
            n_ever = our_orders(con, msk, vc, date, tlabel, live=False)
            if not m:
                rows.append([date, label, str(art[vc]), "весь день", "",
                             "", "",
                             n_live, "", "", "", "", "",
                             n_ever, "", "", "", "", ""])
                continue
            win = "весь день" if m["t"] == "весь день" else f"≤{m['t']}"
            m_ord, m_cpo, spend = m["orders"], m["cpo"], m["spend"]
            cpo_live, cpo_ever = cpo(spend, n_live), cpo(spend, n_ever)
            rows.append([
                date, label, str(art[vc]), win, spend,
                m_ord, m_cpo,
                n_live, d_abs(n_live, m_ord), d_pct(n_live, m_ord),
                cpo_live, d_abs(cpo_live, m_cpo) if cpo_live != "" else "", d_pct(cpo_live, m_cpo) if cpo_live != "" else "",
                n_ever, d_abs(n_ever, m_ord), d_pct(n_ever, m_ord),
                cpo_ever, d_abs(cpo_ever, m_cpo) if cpo_ever != "" else "", d_pct(cpo_ever, m_cpo) if cpo_ever != "" else "",
            ])
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
