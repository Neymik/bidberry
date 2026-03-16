# CPS Order Monitoring Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Мониторинг заказов CPS" page that tracks per-product advertising expenses via WB API, calculates CPS (Cost Per Sale), and displays hourly/daily charts.

**Architecture:** New scheduler task polls WB financial endpoints every 15 min, stores expenses in MySQL, computes CPS at query time from expense + order data + user-defined buyout%. Frontend is a new React page with table + Chart.js expandable rows.

**Tech Stack:** Bun + Hono + MySQL (mysql2) + React 19 + Chart.js (CDN) + Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-16-cps-order-monitoring-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `docker/init.sql` | Add 3 new tables |
| Modify | `src/types/index.ts` | Add expense/payment/settings types |
| Modify | `src/api/wb-client.ts` | Add getExpenseHistory(), getPaymentsHistory() |
| Create | `src/db/monitoring-repository.ts` | CRUD for expenses, payments, settings, CPS queries |
| Create | `src/services/financial-sync.ts` | Sync logic for scheduler |
| Create | `src/web/monitoring-routes.ts` | /api/monitoring/* endpoints (full paths) |
| Modify | `src/web/routes.ts` | Mount monitoring routes |
| Modify | `src/index.ts` | Register scheduler task + /monitoring SPA route |
| Create | `public/app/components/monitoring/MonitoringPage.tsx` | Main page component |
| Modify | `public/app/App.tsx` | Add /monitoring route |
| Modify | `public/app/components/layout/AppSidebar.tsx` | Add nav item |

---

## Chunk 1: Backend Data Layer

### Task 1: Database Schema

**Files:**
- Modify: `docker/init.sql`

- [ ] **Step 1: Add campaign_expenses table to init.sql**

Append after the `search_cluster_stats` table (around line 481):

```sql
-- Campaign expense history (from /adv/v1/upd)
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

-- Account top-up history (from /adv/v1/payments)
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

-- Per-product CPS settings (user-defined)
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

- [ ] **Step 2: Run migration on live DB**

Since init.sql only runs on fresh DB, execute the CREATE TABLE statements directly:

```bash
docker exec wb-analytics-mysql mysql -uwb_user -p'wb_s3cur3_p@ss2024' wb_analytics -e "
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

CREATE TABLE IF NOT EXISTS product_cps_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  nm_id BIGINT NOT NULL,
  buyout_pct DECIMAL(5,2) NOT NULL DEFAULT 80.00,
  planned_budget_daily INT DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product_settings (cabinet_id, nm_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"
```

Expected: `Query OK, 0 rows affected` for each table.

- [ ] **Step 3: Commit**

```bash
git add docker/init.sql
git commit -m "feat(monitoring): add campaign_expenses, account_payments, product_cps_settings tables"
```

---

### Task 2: TypeScript Types

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: Add types for expenses, payments, and CPS settings**

Append to `src/types/index.ts`:

```typescript
// === Campaign Expense (from /adv/v1/upd) ===

export interface WBExpenseRecord {
  updNum: number;
  updTime: string;
  updSum: number;
  advertId: number;
  campName: string;
  advertType: number;
  paymentType: string;
  advertStatus: number;
}

export interface DBCampaignExpense {
  id: number;
  cabinet_id: number;
  advert_id: number;
  upd_num: number;
  upd_time: string;
  upd_sum: number;
  campaign_name: string;
  advert_type: number;
  payment_type: string;
  advert_status: number;
  created_at: string;
}

// === Account Payment (from /adv/v1/payments) ===

export interface WBPaymentRecord {
  id: number;
  date: string;
  sum: number;
  type: number;
  statusId: number;
  cardStatus: string;
}

export interface DBAccountPayment {
  id: number;
  cabinet_id: number;
  payment_id: number;
  payment_date: string;
  sum: number;
  type: number;
  status_id: number;
  card_status: string;
  created_at: string;
}

// === Product CPS Settings ===

export interface DBProductCpsSettings {
  id: number;
  cabinet_id: number;
  nm_id: number;
  buyout_pct: number;
  planned_budget_daily: number | null;
  updated_at: string;
}

// === Monitoring API Response Types ===

export interface MonitoringProduct {
  nmId: number;
  name: string;
  campaigns: { id: number; name: string; status: string }[];
  spendHourly: number;
  spendDaily: number;
  ordersHourly: number;
  ordersDaily: number;
  buyoutPct: number;
  cpsHourly: number | null;
  cpsDaily: number | null;
  plannedBudgetDaily: number | null;
}

export interface CpsChartPoint {
  time: string;
  spend: number;
  orders: number;
  cps: number | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(monitoring): add expense, payment, CPS settings types"
```

---

### Task 3: WB API Client Methods

**Files:**
- Modify: `src/api/wb-client.ts`

- [ ] **Step 1: Add getExpenseHistory method**

Add after the `setCampaignBudget` method (around line 450):

```typescript
  // Получить историю расходов по кампаниям (UPD — списания)
  async getExpenseHistory(dateFrom: string, dateTo: string): Promise<WBExpenseRecord[]> {
    return this.request<WBExpenseRecord[]>(
      WB_API_BASE,
      `/adv/v1/upd?from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}`
    );
  }

  // Получить историю пополнений рекламного кабинета
  async getPaymentsHistory(dateFrom: string, dateTo: string): Promise<WBPaymentRecord[]> {
    return this.request<WBPaymentRecord[]>(
      WB_API_BASE,
      `/adv/v1/payments?from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}`
    );
  }
```

- [ ] **Step 2: Add WBExpenseRecord and WBPaymentRecord to imports**

Update the import block at the top of `wb-client.ts`:

```typescript
import type {
  WBCampaign,
  WBCampaignStats,
  WBBid,
  WBProductAnalytics,
  WBKeywordStat,
  WBOrder,
  WBStock,
  WBExpenseRecord,
  WBPaymentRecord,
} from '../types';
```

- [ ] **Step 3: Commit**

```bash
git add src/api/wb-client.ts
git commit -m "feat(monitoring): add getExpenseHistory and getPaymentsHistory to WB client"
```

---

### Task 4: Monitoring Repository

**Files:**
- Create: `src/db/monitoring-repository.ts`

- [ ] **Step 1: Create monitoring repository with upsert functions**

```typescript
import { query, execute } from './connection';
import type {
  WBExpenseRecord,
  WBPaymentRecord,
  DBProductCpsSettings,
  MonitoringProduct,
  CpsChartPoint,
} from '../types';

// === Expense Upserts ===

export async function upsertExpense(cabinetId: number, expense: WBExpenseRecord): Promise<void> {
  await execute(
    `INSERT INTO campaign_expenses
      (cabinet_id, advert_id, upd_num, upd_time, upd_sum, campaign_name, advert_type, payment_type, advert_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      upd_sum = VALUES(upd_sum),
      campaign_name = VALUES(campaign_name),
      advert_status = VALUES(advert_status)`,
    [
      cabinetId,
      expense.advertId,
      expense.updNum,
      new Date(expense.updTime),
      expense.updSum,
      expense.campName || '',
      expense.advertType ?? 0,
      expense.paymentType || '',
      expense.advertStatus ?? 0,
    ]
  );
}

export async function upsertExpenseBatch(cabinetId: number, expenses: WBExpenseRecord[]): Promise<number> {
  let count = 0;
  for (const expense of expenses) {
    try {
      await upsertExpense(cabinetId, expense);
      count++;
    } catch (e: any) {
      console.warn(`[monitoring] Failed to upsert expense ${expense.updNum}: ${e.message}`);
    }
  }
  return count;
}

// === Payment Upserts ===

export async function upsertPayment(cabinetId: number, payment: WBPaymentRecord): Promise<void> {
  await execute(
    `INSERT INTO account_payments
      (cabinet_id, payment_id, payment_date, sum, type, status_id, card_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      sum = VALUES(sum),
      status_id = VALUES(status_id),
      card_status = VALUES(card_status)`,
    [
      cabinetId,
      payment.id,
      new Date(payment.date),
      payment.sum,
      payment.type ?? 0,
      payment.statusId ?? 0,
      payment.cardStatus || '',
    ]
  );
}

export async function upsertPaymentBatch(cabinetId: number, payments: WBPaymentRecord[]): Promise<number> {
  let count = 0;
  for (const payment of payments) {
    try {
      await upsertPayment(cabinetId, payment);
      count++;
    } catch (e: any) {
      console.warn(`[monitoring] Failed to upsert payment ${payment.id}: ${e.message}`);
    }
  }
  return count;
}

// === Campaign Budget Update (targeted, avoids corrupting other fields) ===

export async function updateCampaignBudget(cabinetId: number, campaignId: number, dailyBudget: number): Promise<void> {
  await execute(
    'UPDATE campaigns SET daily_budget = ? WHERE cabinet_id = ? AND campaign_id = ?',
    [dailyBudget, cabinetId, campaignId]
  );
}

// === CPS Settings ===

export async function getProductCpsSettings(cabinetId: number, nmId: number): Promise<DBProductCpsSettings | null> {
  const rows = await query<DBProductCpsSettings[]>(
    'SELECT * FROM product_cps_settings WHERE cabinet_id = ? AND nm_id = ?',
    [cabinetId, nmId]
  );
  return rows[0] || null;
}

export async function getAllCpsSettings(cabinetId: number): Promise<DBProductCpsSettings[]> {
  return query<DBProductCpsSettings[]>(
    'SELECT * FROM product_cps_settings WHERE cabinet_id = ?',
    [cabinetId]
  );
}

export async function upsertCpsSettings(
  cabinetId: number,
  nmId: number,
  buyoutPct: number,
  plannedBudgetDaily: number | null
): Promise<void> {
  await execute(
    `INSERT INTO product_cps_settings (cabinet_id, nm_id, buyout_pct, planned_budget_daily)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      buyout_pct = VALUES(buyout_pct),
      planned_budget_daily = VALUES(planned_budget_daily)`,
    [cabinetId, nmId, buyoutPct, plannedBudgetDaily ?? null]
  );
}

// === CPS Aggregation Queries ===

/**
 * Get campaigns linked to a product via campaign_products table.
 */
export async function getCampaignsForProduct(
  cabinetId: number,
  nmId: number
): Promise<{ campaign_id: number; name: string; status: string }[]> {
  return query(
    `SELECT cp.campaign_id, c.name, c.status
     FROM campaign_products cp
     JOIN campaigns c ON c.cabinet_id = cp.cabinet_id AND c.campaign_id = cp.campaign_id
     WHERE cp.cabinet_id = ? AND cp.nm_id = ?`,
    [cabinetId, nmId]
  );
}

/**
 * Get total spend for specific campaigns in a time period.
 */
export async function getSpendForCampaigns(
  cabinetId: number,
  campaignIds: number[],
  dateFrom: string,
  dateTo: string
): Promise<number> {
  if (campaignIds.length === 0) return 0;
  const placeholders = campaignIds.map(() => '?').join(',');
  const rows = await query<{ total: number }[]>(
    `SELECT COALESCE(SUM(upd_sum), 0) as total
     FROM campaign_expenses
     WHERE cabinet_id = ? AND advert_id IN (${placeholders})
       AND upd_time >= ? AND upd_time < ?`,
    [cabinetId, ...campaignIds, dateFrom, dateTo]
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Get order count for a product in a time period (non-cancelled).
 */
export async function getOrderCountForProduct(
  cabinetId: number,
  nmId: number,
  dateFrom: string,
  dateTo: string
): Promise<number> {
  const rows = await query<{ cnt: number }[]>(
    `SELECT COUNT(*) as cnt FROM orders
     WHERE cabinet_id = ? AND nm_id = ? AND date_created >= ? AND date_created < ?
       AND is_cancel = 0`,
    [cabinetId, nmId, dateFrom, dateTo]
  );
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Get hourly spend breakdown for campaigns.
 */
export async function getHourlySpend(
  cabinetId: number,
  campaignIds: number[],
  dateFrom: string,
  dateTo: string
): Promise<{ hour: string; spend: number }[]> {
  if (campaignIds.length === 0) return [];
  const placeholders = campaignIds.map(() => '?').join(',');
  const rows = await query<any[]>(
    `SELECT DATE_FORMAT(upd_time, '%Y-%m-%d %H:00:00') as hour,
            COALESCE(SUM(upd_sum), 0) as spend
     FROM campaign_expenses
     WHERE cabinet_id = ? AND advert_id IN (${placeholders})
       AND upd_time >= ? AND upd_time < ?
     GROUP BY hour ORDER BY hour`,
    [cabinetId, ...campaignIds, dateFrom, dateTo]
  );
  return rows.map(r => ({ hour: r.hour, spend: Number(r.spend) }));
}

/**
 * Get hourly order count for a product.
 */
export async function getHourlyOrders(
  cabinetId: number,
  nmId: number,
  dateFrom: string,
  dateTo: string
): Promise<{ hour: string; orders: number }[]> {
  const rows = await query<any[]>(
    `SELECT DATE_FORMAT(date_created, '%Y-%m-%d %H:00:00') as hour,
            COUNT(*) as orders
     FROM orders
     WHERE cabinet_id = ? AND nm_id = ? AND date_created >= ? AND date_created < ?
       AND is_cancel = 0
     GROUP BY hour ORDER BY hour`,
    [cabinetId, nmId, dateFrom, dateTo]
  );
  return rows.map(r => ({ hour: r.hour, orders: Number(r.orders) }));
}

/**
 * Get daily spend breakdown for campaigns.
 */
export async function getDailySpend(
  cabinetId: number,
  campaignIds: number[],
  dateFrom: string,
  dateTo: string
): Promise<{ day: string; spend: number }[]> {
  if (campaignIds.length === 0) return [];
  const placeholders = campaignIds.map(() => '?').join(',');
  const rows = await query<any[]>(
    `SELECT DATE(upd_time) as day,
            COALESCE(SUM(upd_sum), 0) as spend
     FROM campaign_expenses
     WHERE cabinet_id = ? AND advert_id IN (${placeholders})
       AND upd_time >= ? AND upd_time < ?
     GROUP BY day ORDER BY day`,
    [cabinetId, ...campaignIds, dateFrom, dateTo]
  );
  return rows.map(r => ({ day: String(r.day), spend: Number(r.spend) }));
}

/**
 * Get daily order count for a product.
 */
export async function getDailyOrders(
  cabinetId: number,
  nmId: number,
  dateFrom: string,
  dateTo: string
): Promise<{ day: string; orders: number }[]> {
  const rows = await query<any[]>(
    `SELECT DATE(date_created) as day,
            COUNT(*) as orders
     FROM orders
     WHERE cabinet_id = ? AND nm_id = ? AND date_created >= ? AND date_created < ?
       AND is_cancel = 0
     GROUP BY day ORDER BY day`,
    [cabinetId, nmId, dateFrom, dateTo]
  );
  return rows.map(r => ({ day: String(r.day), orders: Number(r.orders) }));
}

/**
 * Get latest sync timestamp from import_history for financial-sync.
 */
export async function getLastFinancialSyncStatus(cabinetId: number): Promise<{
  lastSyncAt: string | null;
  status: string;
  recordsSynced: number;
} | null> {
  const rows = await query<any[]>(
    `SELECT completed_at as lastSyncAt, status, records_count as recordsSynced
     FROM import_history
     WHERE cabinet_id = ? AND import_type = 'financial-sync'
     ORDER BY id DESC LIMIT 1`,
    [cabinetId]
  );
  return rows[0] || null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/db/monitoring-repository.ts
git commit -m "feat(monitoring): add monitoring repository with expense, payment, CPS queries"
```

---

### Task 5: Financial Sync Service

**Files:**
- Create: `src/services/financial-sync.ts`

- [ ] **Step 1: Create financial sync service**

```typescript
import dayjs from 'dayjs';
import type { WBApiClient } from '../api/wb-client';
import * as monitoringRepo from '../db/monitoring-repository';
import * as repo from '../db/repository';

export async function syncFinancial(cabinetId: number, wbClient: WBApiClient): Promise<number> {
  const dateFrom = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const dateTo = dayjs().format('YYYY-MM-DD');
  let totalRecords = 0;

  // 1. Sync expense history
  try {
    const expenses = await wbClient.getExpenseHistory(dateFrom, dateTo);
    if (Array.isArray(expenses)) {
      const count = await monitoringRepo.upsertExpenseBatch(cabinetId, expenses);
      totalRecords += count;
      console.log(`[financial-sync] Cabinet ${cabinetId}: synced ${count} expenses`);
    }
  } catch (e: any) {
    console.error(`[financial-sync] Cabinet ${cabinetId}: expenses error: ${e.message}`);
  }

  // 2. Sync payment history
  try {
    const payments = await wbClient.getPaymentsHistory(dateFrom, dateTo);
    if (Array.isArray(payments)) {
      const count = await monitoringRepo.upsertPaymentBatch(cabinetId, payments);
      totalRecords += count;
      console.log(`[financial-sync] Cabinet ${cabinetId}: synced ${count} payments`);
    }
  } catch (e: any) {
    console.error(`[financial-sync] Cabinet ${cabinetId}: payments error: ${e.message}`);
  }

  // 3. Update campaign budgets (targeted UPDATE, not full upsert to avoid corrupting other fields)
  try {
    const campaigns = await repo.getCampaigns(cabinetId);
    for (const campaign of campaigns) {
      try {
        const budgetData = await wbClient.getCampaignBudget(campaign.campaign_id);
        if (budgetData?.dailyBudget !== undefined) {
          await monitoringRepo.updateCampaignBudget(cabinetId, campaign.campaign_id, budgetData.dailyBudget);
        }
        await Bun.sleep(100); // Rate limit protection
      } catch (e: any) {
        console.warn(`[financial-sync] Budget for campaign ${campaign.campaign_id}: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[financial-sync] Cabinet ${cabinetId}: budget sync error: ${e.message}`);
  }

  return totalRecords;
}

/**
 * Check if enough time has passed since last sync (5 min minimum).
 */
export async function canSyncNow(cabinetId: number): Promise<boolean> {
  const lastSync = await monitoringRepo.getLastFinancialSyncStatus(cabinetId);
  if (!lastSync?.lastSyncAt) return true;
  const lastTime = new Date(lastSync.lastSyncAt).getTime();
  return Date.now() - lastTime > 5 * 60 * 1000;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/financial-sync.ts
git commit -m "feat(monitoring): add financial sync service"
```

---

## Chunk 2: API Routes & Scheduler

### Task 6: Monitoring API Routes

**Files:**
- Create: `src/web/monitoring-routes.ts`

- [ ] **Step 1: Create monitoring routes**

```typescript
import { Hono } from 'hono';
import dayjs from 'dayjs';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';
import * as monitoringRepo from '../db/monitoring-repository';
import * as repo from '../db/repository';
import { syncFinancial, canSyncNow } from '../services/financial-sync';

const app = new Hono();

// === GET /api/monitoring/products ===
app.get('/api/monitoring/products', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const dateFrom = c.req.query('dateFrom') || dayjs().format('YYYY-MM-DD');
    const dateTo = c.req.query('dateTo') || dayjs().format('YYYY-MM-DD');

    const dateToEnd = dayjs(dateTo).add(1, 'day').format('YYYY-MM-DD');

    // Get all products that have campaign associations
    const products = await repo.getProducts(cabinetId);
    const allSettings = await monitoringRepo.getAllCpsSettings(cabinetId);
    const settingsMap = new Map(allSettings.map(s => [s.nm_id, s]));

    // Current hour boundaries for hourly metrics
    const now = dayjs();
    const currentHourStart = now.startOf('hour').format('YYYY-MM-DD HH:mm:ss');
    const prevHourStart = now.subtract(1, 'hour').startOf('hour').format('YYYY-MM-DD HH:mm:ss');

    const result = [];

    for (const product of products) {
      const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, product.nm_id);
      if (campaigns.length === 0) continue; // Skip products without campaigns

      const campaignIds = campaigns.map(c => c.campaign_id);
      const settings = settingsMap.get(product.nm_id);
      const buyoutPct = Number(settings?.buyout_pct ?? 80);

      // Daily spend and orders
      const spendDaily = await monitoringRepo.getSpendForCampaigns(cabinetId, campaignIds, dateFrom, dateToEnd);
      const ordersDaily = await monitoringRepo.getOrderCountForProduct(cabinetId, product.nm_id, dateFrom, dateToEnd);

      // Hourly spend and orders (previous completed hour)
      const spendHourly = await monitoringRepo.getSpendForCampaigns(cabinetId, campaignIds, prevHourStart, currentHourStart);
      const ordersHourly = await monitoringRepo.getOrderCountForProduct(cabinetId, product.nm_id, prevHourStart, currentHourStart);

      // CPS calculation
      const cpsDaily = ordersDaily > 0 && buyoutPct > 0
        ? Math.round(spendDaily / (ordersDaily * buyoutPct / 100) * 100) / 100
        : null;
      const cpsHourly = ordersHourly > 0 && buyoutPct > 0
        ? Math.round(spendHourly / (ordersHourly * buyoutPct / 100) * 100) / 100
        : null;

      result.push({
        nmId: product.nm_id,
        name: product.name || product.vendor_code || String(product.nm_id),
        campaigns: campaigns.slice(0, 2).map(c => ({
          id: c.campaign_id,
          name: c.name,
          status: c.status,
        })),
        campaignsTotal: campaigns.length,
        spendHourly,
        spendDaily,
        ordersHourly,
        ordersDaily,
        buyoutPct,
        cpsHourly,
        cpsDaily,
        plannedBudgetDaily: settings?.planned_budget_daily ?? null,
      });
    }

    // Get balance
    let balance = { balance: 0, bonus: 0 };
    try {
      const wbClient = getWBClientFromContext(c);
      balance = await wbClient.getBalance();
    } catch {}

    return c.json({ products: result, balance });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === GET /api/monitoring/products/:nmId/chart ===
app.get('/api/monitoring/products/:nmId/chart', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const nmId = parseInt(c.req.param('nmId'));
    const period = c.req.query('period') || 'daily';
    const dateFrom = c.req.query('dateFrom') || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = c.req.query('dateTo') || dayjs().format('YYYY-MM-DD');
    const dateToEnd = dayjs(dateTo).add(1, 'day').format('YYYY-MM-DD');

    const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, nmId);
    const campaignIds = campaigns.map(c => c.campaign_id);
    const settings = await monitoringRepo.getProductCpsSettings(cabinetId, nmId);
    const buyoutPct = Number(settings?.buyout_pct ?? 80);

    let spendData: { time: string; spend: number }[];
    let ordersData: { time: string; orders: number }[];

    if (period === 'hourly') {
      const hourlySpend = await monitoringRepo.getHourlySpend(cabinetId, campaignIds, dateFrom, dateToEnd);
      const hourlyOrders = await monitoringRepo.getHourlyOrders(cabinetId, nmId, dateFrom, dateToEnd);
      spendData = hourlySpend.map(h => ({ time: h.hour, spend: Number(h.spend) }));
      ordersData = hourlyOrders.map(h => ({ time: h.hour, orders: Number(h.orders) }));
    } else {
      const dailySpend = await monitoringRepo.getDailySpend(cabinetId, campaignIds, dateFrom, dateToEnd);
      const dailyOrders = await monitoringRepo.getDailyOrders(cabinetId, nmId, dateFrom, dateToEnd);
      spendData = dailySpend.map(d => ({ time: String(d.day), spend: Number(d.spend) }));
      ordersData = dailyOrders.map(d => ({ time: String(d.day), orders: Number(d.orders) }));
    }

    // Merge spend + orders by time key, compute CPS
    const timeMap = new Map<string, { spend: number; orders: number }>();
    for (const s of spendData) timeMap.set(s.time, { spend: s.spend, orders: 0 });
    for (const o of ordersData) {
      const existing = timeMap.get(o.time) || { spend: 0, orders: 0 };
      existing.orders = o.orders;
      timeMap.set(o.time, existing);
    }

    const points: { time: string; spend: number; orders: number; cps: number | null }[] = [];
    for (const [time, data] of [...timeMap.entries()].sort()) {
      const cps = data.orders > 0 && buyoutPct > 0
        ? Math.round(data.spend / (data.orders * buyoutPct / 100) * 100) / 100
        : null;
      points.push({ time, spend: data.spend, orders: data.orders, cps });
    }

    return c.json({ points });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === PUT /api/monitoring/products/:nmId/settings ===
app.put('/api/monitoring/products/:nmId/settings', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const nmId = parseInt(c.req.param('nmId'));
    const body = await c.req.json<{ buyoutPct?: number; plannedBudgetDaily?: number | null }>();

    const buyoutPct = body.buyoutPct;
    if (buyoutPct !== undefined && (buyoutPct <= 0 || buyoutPct > 100)) {
      return c.json({ error: 'buyoutPct must be between 1 and 100' }, 400);
    }

    const current = await monitoringRepo.getProductCpsSettings(cabinetId, nmId);
    await monitoringRepo.upsertCpsSettings(
      cabinetId,
      nmId,
      buyoutPct ?? Number(current?.buyout_pct ?? 80),
      body.plannedBudgetDaily !== undefined ? body.plannedBudgetDaily : (current?.planned_budget_daily ?? null)
    );

    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === GET /api/monitoring/sync-status ===
app.get('/api/monitoring/sync-status', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const status = await monitoringRepo.getLastFinancialSyncStatus(cabinetId);
    return c.json(status || { lastSyncAt: null, status: 'never', recordsSynced: 0 });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === POST /api/sync/financial ===
app.post('/api/sync/financial', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const wbClient = getWBClientFromContext(c);

    if (!(await canSyncNow(cabinetId))) {
      return c.json({ error: 'Sync was performed less than 5 minutes ago' }, 429);
    }

    const importId = await repo.createImportRecord('financial-sync', undefined, cabinetId);
    try {
      const count = await syncFinancial(cabinetId, wbClient);
      await repo.updateImportRecord(importId, 'completed', count);
      return c.json({ success: true, synced: count });
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      return c.json({ error: error.message }, 500);
    }
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
```

- [ ] **Step 2: Commit**

```bash
git add src/web/monitoring-routes.ts
git commit -m "feat(monitoring): add monitoring API routes"
```

---

### Task 7: Mount Routes & Register Scheduler Task

**Files:**
- Modify: `src/web/routes.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Mount monitoring routes in routes.ts**

In `src/web/routes.ts`, add import alongside existing route imports:

```typescript
import monitoringRoutes from './monitoring-routes';
```

Add mount alongside existing routes (after line 50):

```typescript
app.route('/', monitoringRoutes);
```

This follows the exact same pattern as all other route modules (campaign-routes, product-routes, etc.) where each module defines full paths internally (e.g., `/api/monitoring/products`).

- [ ] **Step 2: Add financial-sync scheduler task to index.ts**

Add import at top of `src/index.ts`:

```typescript
import { syncFinancial } from './services/financial-sync';
```

Add after the last `scheduler.registerTask` call (around line 436):

```typescript
  // --- Financial sync (expenses + payments + budgets) ---
  scheduler.registerTask('financial-sync', 15 * 60 * 1000, async () => {
    await forEachCabinet('financial-sync', async (cabinetId, wbClient) => {
      const importId = await repo.createImportRecord('financial-sync', undefined, cabinetId);
      try {
        const count = await syncFinancial(cabinetId, wbClient);
        await repo.updateImportRecord(importId, 'completed', count);
      } catch (error: any) {
        await repo.updateImportRecord(importId, 'error', 0, error.message);
        throw error;
      }
    });
  });
```

- [ ] **Step 3: Add /monitoring to Bun.serve routes for SPA fallback**

Find the `routes` object in `Bun.serve()` config and add:

```typescript
"/monitoring": index,
```

alongside other routes like `"/campaigns": index`, `"/products": index`, etc.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes.ts src/index.ts
git commit -m "feat(monitoring): mount monitoring routes + register financial-sync scheduler"
```

---

## Chunk 3: Frontend

### Task 8: Monitoring Page Component

**Files:**
- Create: `public/app/components/monitoring/MonitoringPage.tsx`

- [ ] **Step 1: Create the main monitoring page**

```tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';

interface Campaign {
  id: number;
  name: string;
  status: string;
}

interface MonitoringProduct {
  nmId: number;
  name: string;
  campaigns: Campaign[];
  campaignsTotal: number;
  spendHourly: number;
  spendDaily: number;
  ordersHourly: number;
  ordersDaily: number;
  buyoutPct: number;
  cpsHourly: number | null;
  cpsDaily: number | null;
  plannedBudgetDaily: number | null;
}

interface ChartPoint {
  time: string;
  spend: number;
  orders: number;
  cps: number | null;
}

interface SyncStatus {
  lastSyncAt: string | null;
  status: string;
  recordsSynced: number;
}

function formatRub(n: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

function timeSince(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  return `${hours} ч назад`;
}

function syncStatusColor(dateStr: string | null): string {
  if (!dateStr) return 'bg-gray-400';
  const min = (Date.now() - new Date(dateStr).getTime()) / 60000;
  if (min < 20) return 'bg-green-500';
  if (min < 60) return 'bg-yellow-500';
  return 'bg-red-500';
}

export default function MonitoringPage() {
  const { dateFrom, dateTo } = useDateRange();
  const [products, setProducts] = useState<MonitoringProduct[]>([]);
  const [balance, setBalance] = useState({ balance: 0, bonus: 0 });
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expandedNmId, setExpandedNmId] = useState<number | null>(null);
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
  const [chartPeriod, setChartPeriod] = useState<'hourly' | 'daily'>('daily');
  const [editingBuyout, setEditingBuyout] = useState<{ nmId: number; value: string } | null>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<any>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [data, status] = await Promise.all([
        api<{ products: MonitoringProduct[]; balance: { balance: number; bonus: number } }>(
          `/monitoring/products?dateFrom=${dateFrom}&dateTo=${dateTo}`
        ),
        api<SyncStatus>('/monitoring/sync-status'),
      ]);
      setProducts(data.products);
      setBalance(data.balance);
      setSyncStatus(status);
    } catch (e: any) {
      console.error('Monitoring load error:', e.message);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => { loadData(); }, [loadData]);

  // Poll sync status every 60s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await api<SyncStatus>('/monitoring/sync-status');
        setSyncStatus(status);
      } catch {}
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Load chart when row expanded
  useEffect(() => {
    if (!expandedNmId) return;
    (async () => {
      try {
        const data = await api<{ points: ChartPoint[] }>(
          `/monitoring/products/${expandedNmId}/chart?period=${chartPeriod}&dateFrom=${dateFrom}&dateTo=${dateTo}`
        );
        setChartPoints(data.points);
      } catch (e: any) {
        console.error('Chart load error:', e.message);
      }
    })();
  }, [expandedNmId, chartPeriod, dateFrom, dateTo]);

  // Render chart
  useEffect(() => {
    if (!chartRef.current || chartPoints.length === 0) return;
    import('https://cdn.jsdelivr.net/npm/chart.js/+esm').then((ChartModule: any) => {
      const Chart = ChartModule.Chart || ChartModule.default?.Chart;
      const components = ChartModule.registerables || ChartModule.default?.registerables;
      if (components) Chart.register(...components);
      if (chartInstance.current) chartInstance.current.destroy();

      chartInstance.current = new Chart(chartRef.current, {
        type: 'line',
        data: {
          labels: chartPoints.map(p => p.time),
          datasets: [
            {
              label: 'Расход (₽)',
              data: chartPoints.map(p => p.spend),
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99,102,241,0.1)',
              yAxisID: 'y',
              tension: 0.3,
            },
            {
              label: 'Заказы',
              data: chartPoints.map(p => p.orders),
              borderColor: '#22c55e',
              backgroundColor: 'rgba(34,197,94,0.1)',
              yAxisID: 'y1',
              tension: 0.3,
            },
            {
              label: 'CPS (₽)',
              data: chartPoints.map(p => p.cps),
              borderColor: '#ef4444',
              backgroundColor: 'rgba(239,68,68,0.1)',
              yAxisID: 'y',
              tension: 0.3,
            },
          ],
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: { type: 'linear', position: 'left', title: { display: true, text: '₽' } },
            y1: { type: 'linear', position: 'right', title: { display: true, text: 'Заказы' }, grid: { drawOnChartArea: false } },
          },
        },
      });
    });
    return () => { if (chartInstance.current) chartInstance.current.destroy(); };
  }, [chartPoints]);

  async function handleSync() {
    setSyncing(true);
    try {
      await api('/sync/financial', { method: 'POST' });
      await loadData();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSyncing(false);
    }
  }

  async function saveBuyout(nmId: number, value: string) {
    const pct = parseFloat(value);
    if (isNaN(pct) || pct <= 0 || pct > 100) return;
    try {
      await api(`/monitoring/products/${nmId}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ buyoutPct: pct }),
      });
      setProducts(prev => prev.map(p => p.nmId === nmId ? { ...p, buyoutPct: pct } : p));
    } catch (e: any) {
      console.error('Save buyout error:', e.message);
    }
    setEditingBuyout(null);
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Загрузка...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Мониторинг заказов CPS</h1>
        <div className="flex items-center gap-4">
          {/* Balance */}
          <div className="text-sm text-gray-600">
            Баланс: <span className="font-semibold text-gray-900">{formatRub(balance.balance)} ₽</span>
          </div>
          {/* Sync status */}
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${syncStatusColor(syncStatus?.lastSyncAt ?? null)}`} />
            <span className="text-sm text-gray-500">
              {syncStatus?.lastSyncAt ? timeSince(syncStatus.lastSyncAt) : 'Нет данных'}
            </span>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50"
          >
            {syncing ? 'Синхронизация...' : 'Обновить'}
          </button>
        </div>
      </div>

      {/* Products table */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Артикул</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Товар</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Кампании</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Расход/час</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Расход/день</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Заказы/час</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Заказы/день</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">% выкупа</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">CPS/час</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">CPS/день</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {products.map(p => (
              <React.Fragment key={p.nmId}>
                <tr
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedNmId(expandedNmId === p.nmId ? null : p.nmId)}
                >
                  <td className="px-4 py-3 text-sm font-mono text-gray-700">{p.nmId}</td>
                  <td className="px-4 py-3 text-sm text-gray-900 max-w-[200px] truncate">{p.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {p.campaigns.map(c => c.name || `#${c.id}`).join(', ')}
                    {p.campaignsTotal > 2 && <span className="text-xs text-gray-400"> +{p.campaignsTotal - 2}</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">{formatRub(p.spendHourly)} ₽</td>
                  <td className={`px-4 py-3 text-sm text-right font-medium ${
                    p.plannedBudgetDaily && p.spendDaily > p.plannedBudgetDaily ? 'text-red-600' : 'text-gray-700'
                  }`}>
                    {formatRub(p.spendDaily)} ₽
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">{p.ordersHourly}</td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">{p.ordersDaily}</td>
                  <td className="px-4 py-3 text-sm text-right" onClick={e => e.stopPropagation()}>
                    {editingBuyout?.nmId === p.nmId ? (
                      <input
                        type="number"
                        className="w-16 px-1 py-0.5 text-sm border rounded text-right"
                        value={editingBuyout.value}
                        onChange={e => setEditingBuyout({ nmId: p.nmId, value: e.target.value })}
                        onBlur={() => saveBuyout(p.nmId, editingBuyout.value)}
                        onKeyDown={e => e.key === 'Enter' && saveBuyout(p.nmId, editingBuyout.value)}
                        autoFocus
                        min={1}
                        max={100}
                      />
                    ) : (
                      <span
                        className="cursor-pointer hover:text-purple-600"
                        onClick={() => setEditingBuyout({ nmId: p.nmId, value: String(p.buyoutPct) })}
                      >
                        {p.buyoutPct}%
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium">
                    {p.cpsHourly !== null ? (
                      <span className={p.cpsHourly > 500 ? 'text-red-600' : 'text-green-600'}>
                        {formatRub(p.cpsHourly)} ₽
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium">
                    {p.cpsDaily !== null ? (
                      <span className={p.cpsDaily > 500 ? 'text-red-600' : 'text-green-600'}>
                        {formatRub(p.cpsDaily)} ₽
                      </span>
                    ) : '—'}
                  </td>
                </tr>

                {/* Expandable chart row */}
                {expandedNmId === p.nmId && (
                  <tr>
                    <td colSpan={10} className="px-4 py-4 bg-gray-50">
                      <div className="flex items-center gap-2 mb-4">
                        <span className="text-sm font-medium text-gray-700">Период:</span>
                        <button
                          className={`px-3 py-1 text-xs rounded ${chartPeriod === 'hourly' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
                          onClick={() => setChartPeriod('hourly')}
                        >
                          По часам
                        </button>
                        <button
                          className={`px-3 py-1 text-xs rounded ${chartPeriod === 'daily' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
                          onClick={() => setChartPeriod('daily')}
                        >
                          По дням
                        </button>
                      </div>
                      <div className="h-72">
                        <canvas ref={chartRef} />
                      </div>
                      {chartPoints.length === 0 && (
                        <div className="text-center text-gray-400 text-sm mt-4">Нет данных за выбранный период</div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  Нет товаров с привязанными рекламными кампаниями
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add public/app/components/monitoring/MonitoringPage.tsx
git commit -m "feat(monitoring): add MonitoringPage component with CPS table and chart"
```

---

### Task 9: App Integration (Routes + Sidebar)

**Files:**
- Modify: `public/app/App.tsx`
- Modify: `public/app/components/layout/AppSidebar.tsx`

- [ ] **Step 1: Add /monitoring route to App.tsx**

Add import at top:

```tsx
import MonitoringPage from './components/monitoring/MonitoringPage';
```

Add route alongside existing routes (after campaigns or products route):

```tsx
<Route path="/monitoring" element={<MonitoringPage />} />
```

- [ ] **Step 2: Add nav item to AppSidebar.tsx**

Add to the `navItems` array:

```tsx
{ path: '/monitoring', label: 'Мониторинг CPS', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
```

- [ ] **Step 3: Commit**

```bash
git add public/app/App.tsx public/app/components/layout/AppSidebar.tsx
git commit -m "feat(monitoring): add monitoring route and sidebar nav item"
```

---

### Task 10: Build & Smoke Test

- [ ] **Step 1: Rebuild Docker container**

```bash
docker compose up -d --build
```

Expected: Container rebuilds and starts successfully.

- [ ] **Step 2: Verify tables exist**

```bash
docker exec wb-analytics-mysql mysql -uwb_user -p'wb_s3cur3_p@ss2024' wb_analytics -e "SHOW TABLES LIKE '%expense%'; SHOW TABLES LIKE '%payment%'; SHOW TABLES LIKE '%cps%';"
```

Expected: 3 tables shown.

- [ ] **Step 3: Test API endpoints**

```bash
# Get monitoring products (should return empty or with data if campaigns exist)
TOKEN=$(curl -s http://localhost:11000/api/auth/login -H 'Content-Type: application/json' -d '...' | jq -r .token)
curl -s http://localhost:11000/api/monitoring/products -H "Authorization: Bearer $TOKEN" -H "X-Cabinet-Id: 1" | jq .

# Test sync status
curl -s http://localhost:11000/api/monitoring/sync-status -H "Authorization: Bearer $TOKEN" -H "X-Cabinet-Id: 1" | jq .

# Manual sync trigger
curl -s -X POST http://localhost:11000/api/sync/financial -H "Authorization: Bearer $TOKEN" -H "X-Cabinet-Id: 1" | jq .
```

- [ ] **Step 4: Verify page loads in browser**

Navigate to `http://localhost:11000/monitoring` — should show the monitoring page with table header and sync status.

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(monitoring): smoke test fixes"
```
