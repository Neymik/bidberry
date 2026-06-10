# Scraper v2 plan — WB Partners 2.34.0 "Лента заказов"

Status: **implemented 2026-06-10** (`ui/feed_v1.py` + `ui/feed_v2.py` + version shim).
v1 behavior is frozen in `ui/feed_v1.py`; the emulator path is unchanged.

## Implementation findings (2026-06-10, on the phone) — corrections to this plan

1. **Navigation did NOT move to Аналитика on this account.** The "Лента заказов"
   section is still on the home dashboard (below Баланс / Заказы FBS / Продвижение),
   and the Аналитика widgets page has no feed block at all. v2 therefore reuses the
   v1 dashboard path ("Лента заказов" + same-row "Ещё") as primary, with an
   Аналитика-page fallback kept for other UI variants. v1 broke because the
   *monitor's* `navigate_to_orders` taps fixed carousel coordinates, not because
   the section disappeared.
2. **The date picker filters by "Дата текущего статуса" (status date), not order
   date.** Verified: a 09.06–09.06 range showed orders placed 26.05–08.06 whose
   status changed on 09.06, and hid an order placed 09.06 whose status changed
   10.06. Since status_date >= order_date, `feed_v2.run(since=S)` picks
   [S .. today] and filters by "Дата оформления" in code.
3. Picker UI: presets Неделя/2 недели/Месяц + calendar with clickable day cells
   (accessible text "Вторник, 9 июня 2026 г."); tap start day, tap end day,
   "Применить". **Only the last 30 days are offered.**
4. Картa fields confirmed; `wb_tag_text` carries the status badge; the new
   "Дата текущего статуса" is captured as non-key `status_date`; the category
   line is captured into the existing `category` DB column.

## Why

WB Partners updated on the production phone **2.31.1 → 2.34.0**. The real‑time order
feed ("Лента заказов") was **moved off the home dashboard into the Аналитика
(seller analytics) section**. The current scraper navigates via the home dashboard,
so it can't reach the feed on 2.34. The emulator is still 2.31.1, which is why v1
keeps working there.

## What actually changed (verified on the phone, 2026‑06‑10)

| Aspect | v1 (2.31.1, emulator) | v2 (2.34.0, phone) |
|---|---|---|
| Feed location | Home dashboard → "Лента заказов" section → "Ещё" | Home → **Аналитика** → "Лента заказов" block → "Ещё" |
| Feed page title | "Лента заказов" | "Лента заказов" (rid `top_app_bar_header_text`) |
| Tabs | Заказы/Выкупы/Отказы/Возвраты | **Все**/Заказы/Выкупы/Отказы/Возвраты (rid `tab_name`) |
| Date filter | none | **date‑range picker** (rid `date_picker_range_text`, default last 7 days) |
| Sort order | newest **Дата оформления** first | newest **Дата текущего статуса** first |
| Status badge | text node | rid `wb_tag_text` (still a text node) |
| Card fields | product, category, article, vendor, size, qty, Статус, Дата оформления, Стоимость, Прибытие, Склад WB | **same** + new **"Дата текущего статуса"** |
| Card container | 1 `scrollable` (wb.partners); each direct child = 1 card | **identical** (1 scrollable, child = card, ~18 text nodes) |

### Good news
- The **card container shape is unchanged**: `for card in scrollable` still yields one
  order per child. The existing `parse_orders()` field mapping works as‑is — the new
  "Дата текущего статуса" is harmlessly ignored (the order `date` is already taken from
  "Дата оформления"), and `category` is just an extra leading text.
- **`build_key()` is unchanged** → v2 keys match the existing DB, so dedup / merge / the
  Google‑Sheets exports keep working across versions.

### The real problems
1. **Navigation** is different (Аналитика path) → must be rewritten.
2. **Sort is by "Дата текущего статуса"**, not order date. The v1 backfill assumes the
   feed descends by order date and stops when "oldest visible < cutoff". That assumption
   is now false — an old order can resurface at the top when its status changes (e.g. a
   buyout today of an order placed last week). So the scroll‑cutoff‑by‑order‑date and
   `--stop-on-known` heuristics are unreliable on 2.34.
3. The **date‑range picker** is the new, correct way to bound a backfill (but we must
   confirm whether it filters by Дата оформления or Дата текущего статуса).

## Design: keep v1, add v2 behind a version check

Do **not** edit v1 in place. Add a thin version‑aware layer:

```
WBPartners-Auto/
  db.py                     # unchanged (build_key stays identical)
  ui/
    __init__.py             # detect_app_version(serial) -> "2.31" | "2.34"
    feed_v1.py              # = today's open_feed.py + backfill parse/scroll (moved, not deleted)
    feed_v2.py              # NEW: 2.34 navigation + scroll/range; reuses parse_orders
  open_feed.py              # thin shim -> ui.feed_vX.open_feed(serial)
  backfill_range.py         # thin shim -> ui.feed_vX.run(...)
  wb_order_monitor.py       # call ui.feed_vX.* based on detected version
```
`detect_app_version()` = `adb shell dumpsys package wb.partners | grep versionName`
(≥ 2.33 → v2, else v1). This lets the emulator (2.31) and phone (2.34) both work from
one codebase, and is trivially revertible.

### v2 navigation (`feed_v2.open_feed`)
By text/resource‑id, not fixed coordinates:
1. Relaunch app / go Home; dismiss popups (Не сейчас / close‑sheet) as v1 does.
2. Tap dashboard button **"Аналитика"** (text match).
3. On the Аналитика page, find the **"Лента заказов"** label, tap the **"Ещё"** whose
   bounds are on the same row / nearest to its right (avoid the Новости "Ещё").
4. Confirm feed open: `top_app_bar_header_text == "Лента заказов"` **and** `tab_name`
   tabs present **and** `date_picker_range_text` present. Retry on the 2.34 "Что‑то
   пошло не так" error by tapping "Обновить" (same as v1).

### v2 parser (`feed_v2.parse_orders`)
Start from a copy of v1 `parse_orders` (container logic identical). Tighten only:
- Read status from the `wb_tag_text` node directly (more robust than "Статус"→next).
- Explicitly skip the "Дата текущего статуса" value so it can never become `date`
  (already safe via the "date already set" guard, but make it explicit).
- Optionally capture `status_date` (Дата текущего статуса) as a new, non‑key field for
  diagnostics. **Do not** put it in `build_key` (keeps keys DB‑compatible).

### v2 backfill strategy (`feed_v2.run`) — use the date picker, not scroll‑cutoff
Because sort is by status date:
- **Preferred:** drive the **date‑range picker** to bound the window (e.g. one day or a
  small span), then scroll the *bounded* list to its end, collecting every card and
  deduping by key. Termination = "end of list / N scrolls with no new keys", not
  "oldest order date < cutoff".
- **Confirm during impl:** does the picker filter by Дата оформления or Дата текущего
  статуса? If by status date, widen the picked range by a few days and filter by
  Дата оформления in code so orders placed in‑range but updated later aren't missed.
- Keep **incremental upsert per card** (the v1 fix from this session) so external
  process kills never lose progress.
- `--stop-on-known` becomes best‑effort only; rely on the date‑range bound for
  correctness.

### v2 live monitor
- Navigate via `feed_v2.open_feed`, select the **"Заказы"** tab, keep the default recent
  range, poll the top for new `Заказ` cards, dedupe by key. Freshly placed orders have
  status_date ≈ order_date and appear at the top, so detection works like v1.

## Validation before switching over
1. Save a 2.34 feed dump as a fixture (`tests/fixtures/feed_2_34.xml`) and unit‑test
   `feed_v2.parse_orders` against it (assert article/vendor/size/qty/status/date/price/
   city/warehouse + key for a known card).
2. On the phone: run a bounded v2 backfill for one settled day; compare the resulting
   `status='Заказ'` count to the WB dashboard "Заказы" number for that day (±5%, the
   tolerance we already validated for v1).
3. Confirm keys collide correctly with existing rows (no accidental duplicates) by
   re‑scraping a day already present and checking inserted==0.

## Rollout
1. Land v1 move + version shim (no behaviour change on the emulator).
2. Build & validate `feed_v2` against the phone.
3. Point the production monitor at v2; keep the emulator/v1 path as fallback.
4. **Only after** v2 is proven in production: consider retiring v1. Not now.

## Open questions to resolve in implementation
- Date‑picker filter semantics (order date vs status date) and how to set a custom range
  via adb (tap picker → choose start/end → apply).
- Whether the "Заказы" tab re‑sorts by order date (it appeared to still sort by status
  date in a quick check — assume status date until proven otherwise).
- Exact "Ещё" disambiguation on the Аналитика page across accounts/UI variants.
