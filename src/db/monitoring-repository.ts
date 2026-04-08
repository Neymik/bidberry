import { query, execute } from './connection';
import type {
  WBExpenseRecord,
  WBPaymentRecord,
  DBProductCpsSettings,
} from '../types';

// === Timezone helpers ===
// All DATETIME values in this DB are stored as Moscow time wall-clock
// (MSK = UTC+3). These helpers convert JS Date objects to MSK strings
// for MySQL storage, avoiding timezone confusion.

function toMskString(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const mskMs = date.getTime() + 3 * 3600 * 1000;
  return new Date(mskMs).toISOString().slice(0, 19).replace('T', ' ');
}

function nowMsk(): string {
  return toMskString(new Date());
}

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
      toMskString(expense.updTime),
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
      toMskString(payment.date),
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

// === Budget Snapshots ===

/**
 * Save a budget snapshot and compute spend since previous snapshot.
 * spend = prev_budget - current_budget (when budget decreased = money spent on ads)
 * When budget increased (top-up), we add the top-up amount to get real spend:
 *   spend = prev_budget + top_up_amount - current_budget
 * top_up_amount is detected when current > prev (budget went up).
 */
export async function saveBudgetSnapshot(
  cabinetId: number,
  campaignId: number,
  budget: number,
  dailyBudget: number
): Promise<void> {
  // Get previous snapshot
  const prevRows = await query<any[]>(
    `SELECT budget, snapshot_at FROM campaign_budget_snapshots
     WHERE cabinet_id = ? AND campaign_id = ?
     ORDER BY snapshot_at DESC LIMIT 1`,
    [cabinetId, campaignId]
  );

  let spendSincePrev: number | null = null;
  if (prevRows.length > 0) {
    const prevBudget = Number(prevRows[0].budget);
    if (budget <= prevBudget) {
      // Budget decreased = spent on ads
      spendSincePrev = Math.round((prevBudget - budget) * 100) / 100;
    } else {
      // Budget increased = top-up happened
      // We can't know exact spend during a top-up interval,
      // so record spend as 0 for this interval (top-up masks it)
      spendSincePrev = 0;
    }
  }

  await execute(
    `INSERT INTO campaign_budget_snapshots
      (cabinet_id, campaign_id, budget, daily_budget, snapshot_at, spend_since_prev)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [cabinetId, campaignId, budget, dailyBudget, nowMsk(), spendSincePrev ?? null]
  );
}

/**
 * Get hourly spend from budget snapshots for specific campaigns.
 * Aggregates spend_since_prev by hour.
 */
export async function getHourlySpendFromSnapshots(
  cabinetId: number,
  campaignIds: number[],
  dateFrom: string,
  dateTo: string
): Promise<{ hour: string; spend: number }[]> {
  if (campaignIds.length === 0) return [];
  const placeholders = campaignIds.map(() => '?').join(',');
  const rows = await query<any[]>(
    `SELECT DATE_FORMAT(snapshot_at, '%Y-%m-%d %H:00:00') as hour,
            COALESCE(SUM(spend_since_prev), 0) as spend
     FROM campaign_budget_snapshots
     WHERE cabinet_id = ? AND campaign_id IN (${placeholders})
       AND snapshot_at >= ? AND snapshot_at < ?
       AND spend_since_prev IS NOT NULL
     GROUP BY hour ORDER BY hour`,
    [cabinetId, ...campaignIds, dateFrom, dateTo]
  );
  return rows.map(r => ({ hour: r.hour, spend: Number(r.spend) }));
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
  plannedBudgetDaily: number | null,
  orderScalePct: number | null = undefined as any
): Promise<void> {
  // If orderScalePct not passed (undefined), preserve existing value
  if (orderScalePct === undefined) {
    await execute(
      `INSERT INTO product_cps_settings (cabinet_id, nm_id, buyout_pct, planned_budget_daily)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        buyout_pct = VALUES(buyout_pct),
        planned_budget_daily = VALUES(planned_budget_daily)`,
      [cabinetId, nmId, buyoutPct, plannedBudgetDaily ?? null]
    );
  } else {
    await execute(
      `INSERT INTO product_cps_settings (cabinet_id, nm_id, buyout_pct, planned_budget_daily, order_scale_pct)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        buyout_pct = VALUES(buyout_pct),
        planned_budget_daily = VALUES(planned_budget_daily),
        order_scale_pct = VALUES(order_scale_pct)`,
      [cabinetId, nmId, buyoutPct, plannedBudgetDaily ?? null, orderScalePct]
    );
  }
}

// === CPS Aggregation Queries ===

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

export async function getDailySpend(
  cabinetId: number,
  campaignIds: number[],
  dateFrom: string,
  dateTo: string
): Promise<{ day: string; spend: number }[]> {
  if (campaignIds.length === 0) return [];
  const placeholders = campaignIds.map(() => '?').join(',');
  const rows = await query<any[]>(
    `SELECT DATE_FORMAT(upd_time, '%Y-%m-%d') as day,
            COALESCE(SUM(upd_sum), 0) as spend
     FROM campaign_expenses
     WHERE cabinet_id = ? AND advert_id IN (${placeholders})
       AND upd_time >= ? AND upd_time < ?
     GROUP BY day ORDER BY day`,
    [cabinetId, ...campaignIds, dateFrom, dateTo]
  );
  return rows.map(r => ({ day: String(r.day), spend: Number(r.spend) }));
}

export async function getDailyOrders(
  cabinetId: number,
  nmId: number,
  dateFrom: string,
  dateTo: string
): Promise<{ day: string; orders: number }[]> {
  const rows = await query<any[]>(
    `SELECT DATE_FORMAT(date_created, '%Y-%m-%d') as day,
            COUNT(*) as orders
     FROM orders
     WHERE cabinet_id = ? AND nm_id = ? AND date_created >= ? AND date_created < ?
       AND is_cancel = 0
     GROUP BY day ORDER BY day`,
    [cabinetId, nmId, dateFrom, dateTo]
  );
  return rows.map(r => ({ day: String(r.day), orders: Number(r.orders) }));
}

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

export async function getLastSyncByType(cabinetId: number, importType: string): Promise<{
  started_at: string;
  status: string;
  records_count: number;
} | null> {
  const rows = await query<any[]>(
    `SELECT started_at, status, records_count
     FROM import_history
     WHERE cabinet_id = ? AND import_type = ?
     ORDER BY id DESC LIMIT 1`,
    [cabinetId, importType]
  );
  return rows[0] || null;
}
