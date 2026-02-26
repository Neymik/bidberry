import { query, execute, transaction } from './connection';
import type {
  DBCampaign,
  DBCampaignStats,
  DBProduct,
  DBProductAnalytics,
  WBCampaign,
  WBCampaignStats,
  WBProductAnalytics,
  DailySummary,
  AnalyticsSummary,
} from '../types';
import dayjs from 'dayjs';

// === CAMPAIGNS ===

export async function upsertCampaign(campaign: WBCampaign): Promise<void> {
  const sql = `
    INSERT INTO campaigns (campaign_id, name, type, status, daily_budget, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      type = VALUES(type),
      status = VALUES(status),
      daily_budget = VALUES(daily_budget),
      start_date = VALUES(start_date),
      end_date = VALUES(end_date)
  `;

  await execute(sql, [
    campaign.advertId,
    campaign.name ?? null,
    getCampaignTypeName(campaign.type),
    getCampaignStatusName(campaign.status),
    campaign.dailyBudget ?? null,
    campaign.startTime ? new Date(campaign.startTime) : null,
    campaign.endTime ? new Date(campaign.endTime) : null,
  ]);
}

export async function upsertCampaigns(campaigns: WBCampaign[]): Promise<number> {
  let count = 0;
  for (const campaign of campaigns) {
    await upsertCampaign(campaign);
    count++;
  }
  return count;
}

export async function getCampaigns(): Promise<DBCampaign[]> {
  return query<DBCampaign[]>('SELECT * FROM campaigns ORDER BY campaign_id DESC');
}

export async function getCampaignById(campaignId: number): Promise<DBCampaign | null> {
  const rows = await query<DBCampaign[]>(
    'SELECT * FROM campaigns WHERE campaign_id = ?',
    [campaignId]
  );
  return rows[0] || null;
}

// === CAMPAIGN STATS ===

export async function upsertCampaignStats(stats: WBCampaignStats): Promise<void> {
  const sql = `
    INSERT INTO campaign_stats
      (campaign_id, date, views, clicks, ctr, cpc, spend, orders, order_sum, atbs, shks, sum_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      views = VALUES(views),
      clicks = VALUES(clicks),
      ctr = VALUES(ctr),
      cpc = VALUES(cpc),
      spend = VALUES(spend),
      orders = VALUES(orders),
      order_sum = VALUES(order_sum),
      atbs = VALUES(atbs),
      shks = VALUES(shks),
      sum_price = VALUES(sum_price)
  `;

  await execute(sql, [
    stats.advertId,
    new Date(stats.date),
    stats.views ?? 0,
    stats.clicks ?? 0,
    stats.ctr ?? 0,
    stats.cpc ?? 0,
    stats.spend ?? 0,
    stats.orders ?? 0,
    stats.ordersSumRub ?? 0,
    stats.atbs ?? 0,
    stats.shks ?? 0,
    stats.sumPrice ?? 0,
  ]);
}

export async function upsertCampaignStatsBatch(statsList: WBCampaignStats[]): Promise<number> {
  let count = 0;
  for (const stats of statsList) {
    await upsertCampaignStats(stats);
    count++;
  }
  return count;
}

export async function getCampaignStats(
  campaignId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBCampaignStats[]> {
  let sql = 'SELECT * FROM campaign_stats WHERE campaign_id = ?';
  const params: any[] = [campaignId];

  if (dateFrom) {
    sql += ' AND date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND date <= ?';
    params.push(dateTo);
  }

  sql += ' ORDER BY date DESC';
  return query<DBCampaignStats[]>(sql, params);
}

// === PRODUCTS ===

export async function upsertProduct(product: {
  nmId: number;
  vendorCode?: string;
  brand?: string;
  subject?: string;
  name?: string;
  price?: number;
  discount?: number;
  finalPrice?: number;
  rating?: number;
  feedbacks?: number;
}): Promise<void> {
  const sql = `
    INSERT INTO products (nm_id, vendor_code, brand, subject, name, price, discount, final_price, rating, feedbacks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      vendor_code = COALESCE(VALUES(vendor_code), vendor_code),
      brand = COALESCE(VALUES(brand), brand),
      subject = COALESCE(VALUES(subject), subject),
      name = COALESCE(VALUES(name), name),
      price = COALESCE(VALUES(price), price),
      discount = COALESCE(VALUES(discount), discount),
      final_price = COALESCE(VALUES(final_price), final_price),
      rating = COALESCE(VALUES(rating), rating),
      feedbacks = COALESCE(VALUES(feedbacks), feedbacks)
  `;

  await execute(sql, [
    product.nmId,
    product.vendorCode || null,
    product.brand || null,
    product.subject || null,
    product.name || null,
    product.price || null,
    product.discount || null,
    product.finalPrice || null,
    product.rating || null,
    product.feedbacks || null,
  ]);
}

export async function getProducts(): Promise<DBProduct[]> {
  return query<DBProduct[]>('SELECT * FROM products ORDER BY nm_id DESC');
}

export async function getProductById(nmId: number): Promise<DBProduct | null> {
  const rows = await query<DBProduct[]>(
    'SELECT * FROM products WHERE nm_id = ?',
    [nmId]
  );
  return rows[0] || null;
}

// === PRODUCT ANALYTICS ===

export async function upsertProductAnalytics(
  analytics: WBProductAnalytics,
  date: string
): Promise<void> {
  // Сначала убедимся, что продукт существует
  await upsertProduct({
    nmId: analytics.nmID,
    vendorCode: analytics.vendorCode,
    brand: analytics.brandName,
    subject: analytics.tags?.subject,
    name: analytics.object?.name,
  });

  const stats = analytics.statistics?.selectedPeriod;
  if (!stats) return;

  const conversionToCart = stats.openCardCount > 0
    ? (stats.addToCartCount / stats.openCardCount) * 100
    : 0;
  const conversionToOrder = stats.addToCartCount > 0
    ? (stats.ordersCount / stats.addToCartCount) * 100
    : 0;

  const sql = `
    INSERT INTO product_analytics
      (nm_id, date, open_card_count, add_to_cart_count, orders_count, orders_sum,
       buyouts_count, buyouts_sum, cancel_count, cancel_sum, conversion_to_cart, conversion_to_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      open_card_count = VALUES(open_card_count),
      add_to_cart_count = VALUES(add_to_cart_count),
      orders_count = VALUES(orders_count),
      orders_sum = VALUES(orders_sum),
      buyouts_count = VALUES(buyouts_count),
      buyouts_sum = VALUES(buyouts_sum),
      cancel_count = VALUES(cancel_count),
      cancel_sum = VALUES(cancel_sum),
      conversion_to_cart = VALUES(conversion_to_cart),
      conversion_to_order = VALUES(conversion_to_order)
  `;

  await execute(sql, [
    analytics.nmID,
    date,
    stats.openCardCount ?? 0,
    stats.addToCartCount ?? 0,
    stats.ordersCount ?? 0,
    stats.ordersSumRub ?? 0,
    stats.buyoutsCount ?? 0,
    stats.buyoutsSumRub ?? 0,
    stats.cancelCount ?? 0,
    stats.cancelSumRub ?? 0,
    conversionToCart,
    conversionToOrder,
  ]);
}

export async function getProductAnalytics(
  nmId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBProductAnalytics[]> {
  let sql = 'SELECT * FROM product_analytics WHERE nm_id = ?';
  const params: any[] = [nmId];

  if (dateFrom) {
    sql += ' AND date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND date <= ?';
    params.push(dateTo);
  }

  sql += ' ORDER BY date DESC';
  return query<DBProductAnalytics[]>(sql, params);
}

// === BIDS ===

export async function saveBids(
  campaignId: number,
  bids: { keyword: string; bid: number; position: number; cpm: number }[]
): Promise<number> {
  // Удаляем старые ставки
  await execute('DELETE FROM bids WHERE campaign_id = ?', [campaignId]);

  // Вставляем новые
  let count = 0;
  for (const bid of bids) {
    await execute(
      'INSERT INTO bids (campaign_id, keyword, bid, position, cpm) VALUES (?, ?, ?, ?, ?)',
      [campaignId, bid.keyword ?? null, bid.bid ?? 0, bid.position ?? 0, bid.cpm ?? 0]
    );
    count++;
  }
  return count;
}

export async function getBids(campaignId: number): Promise<any[]> {
  return query<any[]>(
    'SELECT * FROM bids WHERE campaign_id = ? ORDER BY position ASC',
    [campaignId]
  );
}

// === SUMMARIES ===

export async function getDailySummary(
  dateFrom?: string,
  dateTo?: string
): Promise<DailySummary[]> {
  let sql = `
    SELECT
      DATE_FORMAT(date, '%Y-%m-%d') as date,
      COUNT(DISTINCT campaign_id) as campaigns_count,
      SUM(views) as total_views,
      SUM(clicks) as total_clicks,
      ROUND(SUM(clicks) / NULLIF(SUM(views), 0) * 100, 2) as avg_ctr,
      SUM(spend) as total_spend,
      SUM(orders) as total_orders,
      SUM(order_sum) as total_order_sum,
      ROUND(SUM(order_sum) / NULLIF(SUM(spend), 0), 2) as roas
    FROM campaign_stats
    WHERE 1=1
  `;
  const params: any[] = [];

  if (dateFrom) {
    sql += ' AND date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND date <= ?';
    params.push(dateTo);
  }

  sql += ' GROUP BY date ORDER BY date DESC';
  return query<DailySummary[]>(sql, params);
}

export async function getAnalyticsSummary(
  dateFrom: string,
  dateTo: string
): Promise<AnalyticsSummary> {
  const sql = `
    SELECT
      COUNT(DISTINCT c.campaign_id) as totalCampaigns,
      COUNT(DISTINCT CASE WHEN c.status = 'active' THEN c.campaign_id END) as activeCampaigns,
      COALESCE(SUM(cs.spend), 0) as totalSpend,
      COALESCE(SUM(cs.orders), 0) as totalOrders,
      COALESCE(SUM(cs.order_sum), 0) as totalRevenue,
      ROUND(AVG(cs.ctr), 2) as avgCTR,
      ROUND(AVG(cs.cpc), 2) as avgCPC,
      ROUND(SUM(cs.order_sum) / NULLIF(SUM(cs.spend), 0), 2) as roas
    FROM campaigns c
    LEFT JOIN campaign_stats cs ON c.campaign_id = cs.campaign_id
      AND cs.date BETWEEN ? AND ?
  `;

  const rows = await query<any[]>(sql, [dateFrom, dateTo]);
  const row = rows[0] || {};

  return {
    totalCampaigns: row.totalCampaigns || 0,
    activeCampaigns: row.activeCampaigns || 0,
    totalSpend: row.totalSpend || 0,
    totalOrders: row.totalOrders || 0,
    totalRevenue: row.totalRevenue || 0,
    avgCTR: row.avgCTR || 0,
    avgCPC: row.avgCPC || 0,
    roas: row.roas || 0,
    period: { from: dateFrom, to: dateTo },
  };
}

// === IMPORT HISTORY ===

export async function createImportRecord(
  importType: string,
  fileName?: string
): Promise<number> {
  const result = await execute(
    'INSERT INTO import_history (import_type, file_name, status) VALUES (?, ?, ?)',
    [importType, fileName ?? null, 'pending']
  );
  return result.insertId;
}

export async function updateImportRecord(
  id: number,
  status: string,
  recordsCount?: number,
  errorMessage?: string
): Promise<void> {
  await execute(
    `UPDATE import_history
     SET status = ?, records_count = ?, error_message = ?, completed_at = NOW()
     WHERE id = ?`,
    [status, recordsCount ?? null, errorMessage ?? null, id]
  );
}

export async function getImportHistory(limit = 50): Promise<any[]> {
  return query<any[]>(
    'SELECT * FROM import_history ORDER BY started_at DESC LIMIT ?',
    [limit]
  );
}

// === HELPERS ===

function getCampaignTypeName(type: number): string {
  const types: Record<number, string> = {
    4: 'Каталог',
    5: 'Карточка товара',
    6: 'Поиск',
    7: 'Рекомендации',
    8: 'Авто',
    9: 'Поиск + каталог',
  };
  return types[type] || `Тип ${type}`;
}

function getCampaignStatusName(status: number): string {
  const statuses = new Map<number, string>([
    [-1, 'Удалена'],
    [4, 'Готова к запуску'],
    [7, 'Завершена'],
    [8, 'Отказано'],
    [9, 'Активна'],
    [11, 'Приостановлена'],
  ]);
  return statuses.get(status) || `Статус ${status}`;
}
