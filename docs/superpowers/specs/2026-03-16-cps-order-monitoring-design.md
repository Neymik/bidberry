# CPS Order Monitoring — Design Spec

## Overview

New dashboard page "Мониторинг заказов" that tracks per-product advertising spend and calculates CPS (Cost Per Sale) using real WB API expense data, order counts, and a user-defined buyout percentage.

**Core formula:**
```
CPS = Ad_Spend / (Orders × Buyout%)
```

## Data Sources

### New WB API Endpoints

Two new endpoints to implement in `src/api/wb-client.ts`:

1. **`GET /adv/v1/upd?from=&to=`** — Campaign expense history (actual write-offs)
   - Response: `Array<{ updNum, updTime, updSum, advertId, campName, advertType, paymentType, advertStatus }>`
   - Rate limit: 1 req/sec, burst 5
   - Max range: 31 days

2. **`GET /adv/v1/payments?from=&to=`** — Account top-up history
   - Response: `Array<{ id, date, sum, type, statusId, cardStatus }>`
   - Rate limit: 1 req/sec, burst 5
   - Max range: 31 days

### Existing Data Used

- `campaign_products` table — maps campaigns to products (auto-synced from WB)
- `orders` table — order feed with `date_created` timestamps (hourly granularity)
- `campaigns` table — campaign metadata
- `GET /adv/v1/balance` — already implemented, returns `{ balance, bonus }`
- `GET /adv/v1/budget?id=` — already implemented, returns `{ budget, dailyBudget }`

## Database Schema

### Table: `campaign_expenses`

Stores individual expense records from `/adv/v1/upd`.

```sql
CREATE TABLE IF NOT EXISTS campaign_expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  advert_id BIGINT NOT NULL,
  upd_num BIGINT NOT NULL,
  upd_time DATETIME NOT NULL,
  upd_sum DECIMAL(12,2) NOT NULL DEFAULT 0,
  campaign_name VARCHAR(255) DEFAULT '',
  advert_type INT DEFAULT 0,
  payment_type VARCHAR(50) DEFAULT '',
  advert_status INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_expense (cabinet_id, advert_id, upd_num),
  INDEX idx_advert_time (cabinet_id, advert_id, upd_time),
  INDEX idx_time (cabinet_id, upd_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Table: `account_payments`

Stores account top-up history from `/adv/v1/payments`.

```sql
CREATE TABLE IF NOT EXISTS account_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  payment_id BIGINT NOT NULL,
  payment_date DATETIME NOT NULL,
  sum DECIMAL(12,2) NOT NULL DEFAULT 0,
  type INT DEFAULT 0,
  status_id INT DEFAULT 0,
  card_status VARCHAR(50) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment (cabinet_id, payment_id),
  INDEX idx_date (cabinet_id, payment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Table: `product_cps_settings`

User-defined per-product settings.

```sql
CREATE TABLE IF NOT EXISTS product_cps_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  nm_id BIGINT NOT NULL,
  buyout_pct DECIMAL(5,2) NOT NULL DEFAULT 80.00,
  planned_budget_daily INT DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product_settings (cabinet_id, nm_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

No separate `sync_status` table — use existing `import_history` table and `repo.createImportRecord()` / `repo.updateImportRecord()` pattern for tracking sync status.

## Scheduler Task

### `financial-sync` — every 15 minutes

Registered in `src/index.ts` alongside existing 13 tasks.

```
For each active cabinet:
  1. Create import_history record (import_type = 'financial-sync')
  2. GET /adv/v1/upd?from=<24h_ago>&to=<now>         → upsert into campaign_expenses
  3. GET /adv/v1/payments?from=<24h_ago>&to=<now>     → upsert into account_payments
  4. For each campaign: GET /adv/v1/budget?id=          → update campaigns.daily_budget
     (100ms delay between calls to respect rate limits)
  5. Update import_history record with status + records_count
```

**API load per 15-min poll (~10 campaigns):** ~13 calls = 0.014 req/sec (limit: 1 req/sec).

**Manual sync rate limit:** `POST /api/sync/financial` only allowed if last sync was >5 minutes ago (server-side check against `import_history`).

## CPS Calculation Logic

All CPS values are computed at query time using the current `buyout_pct` from `product_cps_settings` — never pre-computed or stored.

### Per-product CPS for a time period

```sql
-- Step 1: Get campaigns linked to this product
SELECT campaign_id FROM campaign_products WHERE nm_id = ? AND cabinet_id = ?

-- Step 2: Sum expenses for those campaigns in the period
SELECT SUM(upd_sum) as total_spend
FROM campaign_expenses
WHERE cabinet_id = ? AND advert_id IN (?) AND upd_time BETWEEN ? AND ?

-- Step 3: Count non-cancelled orders in the period
SELECT COUNT(*) as order_count
FROM orders
WHERE cabinet_id = ? AND nm_id = ? AND date_created BETWEEN ? AND ? AND is_cancel = 0

-- Step 4: Get buyout percentage
SELECT buyout_pct FROM product_cps_settings WHERE cabinet_id = ? AND nm_id = ?

-- Step 5: Calculate
CPS = total_spend / (order_count * buyout_pct / 100)
-- If orders = 0 or buyout = 0, CPS = NULL (display as "—")
```

### Hourly aggregation (for charts)

Group `campaign_expenses.upd_time` by `DATE_FORMAT(upd_time, '%Y-%m-%d %H:00:00')` and `orders.date_created` by the same pattern. "Hourly" = calendar hour boundaries (e.g. 14:00-14:59).

### Daily aggregation (for table)

Group by `DATE(upd_time)` and `DATE(date_created)`.

### "Hourly" metrics in table

`spendHourly` and `ordersHourly` = values for the most recent completed calendar hour. `cpsHourly` is computed from these — will show "—" when orders=0 in that hour (expected for low-volume products). Daily CPS is the primary metric; hourly is supplementary.

## API Endpoints

All under Hono router, require JWT auth, scoped by `cabinet_id` (via `getCabinetId(c)` middleware).

### `GET /api/monitoring/products`

Returns all products with CPS data for the current period.

**Query params:** `dateFrom`, `dateTo` (default: today)

**Response:**
```json
{
  "products": [
    {
      "nmId": 12345,
      "name": "Product Name",
      "campaigns": [
        { "id": 100, "name": "Search Campaign", "status": 9 },
        { "id": 200, "name": "Auto Campaign", "status": 9 }
      ],
      "spendHourly": 150.5,
      "spendDaily": 3200.0,
      "ordersHourly": 5,
      "ordersDaily": 48,
      "buyoutPct": 80,
      "cpsHourly": 37.63,
      "cpsDaily": 83.33,
      "plannedBudgetDaily": 5000
    }
  ],
  "balance": { "balance": 45000, "bonus": 1200 }
}
```

If a product has 3+ campaigns, show first 2 in table + `"+N more"` indicator. All campaigns used for spend aggregation regardless.

When `spendDaily > plannedBudgetDaily`, the frontend highlights the spend cell in red as a budget overrun warning.

### `GET /api/monitoring/products/:nmId/chart`

CPS in response is computed at query time using current `buyout_pct` — changing buyout% immediately updates the chart on next fetch.

**Query params:** `period=hourly|daily`, `dateFrom`, `dateTo`

**Response:**
```json
{
  "points": [
    {
      "time": "2026-03-16 14:00",
      "spend": 150.5,
      "orders": 5,
      "cps": 37.63
    }
  ]
}
```

### `PUT /api/monitoring/products/:nmId/settings`

Scoped by `cabinet_id` — upserts into `product_cps_settings` matching `(cabinet_id, nm_id)`.

**Validation:** `buyoutPct` must be > 0 and <= 100. `plannedBudgetDaily` must be >= 0 or null.

**Body:** `{ "buyoutPct": 75, "plannedBudgetDaily": 5000 }`

**Response:** `{ "ok": true }`

### `GET /api/monitoring/sync-status`

Reads from `import_history` where `import_type = 'financial-sync'` and `cabinet_id` matches.

**Response:**
```json
{
  "lastSyncAt": "2026-03-16T14:15:00Z",
  "status": "success",
  "recordsSynced": 42
}
```

### `POST /api/sync/financial`

Manual trigger for financial sync. Same logic as scheduler task. Returns 429 if last sync was <5 minutes ago.

## Frontend

### New page: "Мониторинг заказов"

**File:** `public/app/components/monitoring/MonitoringPage.tsx`

**Sidebar entry:** Added to `AppSidebar.tsx` — icon: chart-bar or activity indicator.

**Route:** `/monitoring` — must also be added to `Bun.serve()` routes in `src/index.ts` for SPA fallback (same as other routes like `/campaigns`, `/products`).

### Layout

**Top bar:**
- Sync status badge: "Последняя синхронизация: X мин назад" (green if <20 min, yellow if >20 min, red if >1 hour)
- Button "Обновить" — triggers `POST /api/sync/financial`
- Balance display: "Баланс: XX XXX ₽" — fetched via existing `GET /api/wb/balance` endpoint (live call, not cached)
- Date range picker (reuse existing `useDateRange` hook)

**Products table:**

| Column | Source | Notes |
|--------|--------|-------|
| Артикул | `nmId` | Link to product |
| Товар | `name` | Product name |
| Кампания 1 | `campaigns[0]` | Name + status badge |
| Кампания 2 | `campaigns[1]` | Name + status badge (or "—"), "+N" if 3+ |
| Расход/час | `spendHourly` | In rubles, formatted |
| Расход/день | `spendDaily` | In rubles, red if > plannedBudgetDaily |
| Заказы/час | `ordersHourly` | Count |
| Заказы/день | `ordersDaily` | Count |
| % выкупа | `buyoutPct` | Inline editable input (validated: 1-100) |
| CPS/час | `cpsHourly` | Calculated, colored (green if low, red if high) |
| CPS/день | `cpsDaily` | Calculated, colored |

**Expandable chart row (on click):**
- Chart.js line chart with 3 datasets:
  - Blue line: расход (spend)
  - Green line: заказы (orders)
  - Red line: CPS
- Toggle: hourly (last 24h) / daily (date range)
- Dual Y-axis: left for rubles (spend, CPS), right for count (orders)

### State management

- `useMonitoringData()` hook — fetches `/api/monitoring/products` with date range
- `useChartData(nmId)` hook — fetches chart data when row expanded
- `useSyncStatus()` hook — polls `/api/monitoring/sync-status` every 60 seconds to update the badge
- Inline edit for buyout% — debounced PUT to `/api/monitoring/products/:nmId/settings`

## File Structure

```
src/
  api/wb-client.ts              — add getExpenseHistory(), getPaymentsHistory()
  db/monitoring-repository.ts   — new: CRUD for expenses, payments, settings, CPS queries
  services/financial-sync.ts    — new: sync logic for scheduler
  web/monitoring-routes.ts      — new: /api/monitoring/* endpoints
  index.ts                      — register financial-sync scheduler task + /monitoring route

docker/
  init.sql                      — add 3 new tables (campaign_expenses, account_payments, product_cps_settings)

public/app/
  components/
    monitoring/
      MonitoringPage.tsx         — main page component
      MonitoringTable.tsx        — products table with inline edit
      CpsChart.tsx               — Chart.js chart component
      SyncStatusBadge.tsx        — sync status indicator
  App.tsx                        — add /monitoring route
  components/layout/AppSidebar.tsx — add "Мониторинг заказов" nav item
```

## Future: CPO (Cost Per Order)

Placeholder for future implementation. CPO = Spend / Orders (without buyout multiplier). Can be added as an additional column and chart line once CPS is validated.

## Edge Cases

- **No campaigns linked to product:** Show "—" for spend and CPS columns
- **Zero orders in period:** CPS = "—" (avoid division by zero)
- **Zero buyout%:** Not possible — validation enforces 1-100 range
- **Campaign paused (no spend):** Show 0 for spend, still show orders
- **WB API returns 500 on /adv/v1/upd:** Retry with existing retry utility, mark import_history as error
- **Multiple cabinets:** All data scoped by cabinet_id, no cross-cabinet mixing
- **3+ campaigns per product:** All campaigns used for spend calculation; table shows first 2 + "+N more"
- **Budget overrun:** `spendDaily > plannedBudgetDaily` highlights spend cell red
