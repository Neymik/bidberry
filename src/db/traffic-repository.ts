import { query, execute } from './connection';
import type { DBTrafficSourceAnalytics } from '../types';

export async function upsertTrafficSource(cabinetId: number, data: {
  nm_id: number;
  date: string;
  source_name: string;
  open_card_count: number;
  add_to_cart_count: number;
  orders_count: number;
  orders_sum: number;
  buyouts_count: number;
  buyouts_sum: number;
  cancel_count: number;
  cancel_sum: number;
}): Promise<void> {
  const sql = `
    INSERT INTO traffic_source_analytics
      (cabinet_id, nm_id, date, source_name, open_card_count, add_to_cart_count,
       orders_count, orders_sum, buyouts_count, buyouts_sum, cancel_count, cancel_sum)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      open_card_count = VALUES(open_card_count),
      add_to_cart_count = VALUES(add_to_cart_count),
      orders_count = VALUES(orders_count),
      orders_sum = VALUES(orders_sum),
      buyouts_count = VALUES(buyouts_count),
      buyouts_sum = VALUES(buyouts_sum),
      cancel_count = VALUES(cancel_count),
      cancel_sum = VALUES(cancel_sum)
  `;

  await execute(sql, [
    cabinetId,
    data.nm_id,
    data.date,
    data.source_name,
    data.open_card_count,
    data.add_to_cart_count,
    data.orders_count,
    data.orders_sum,
    data.buyouts_count,
    data.buyouts_sum,
    data.cancel_count,
    data.cancel_sum,
  ]);
}

export async function getTrafficSourcesByNmId(
  cabinetId: number,
  nmId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBTrafficSourceAnalytics[]> {
  let sql = 'SELECT * FROM traffic_source_analytics WHERE cabinet_id = ? AND nm_id = ?';
  const params: any[] = [cabinetId, nmId];

  if (dateFrom) {
    sql += ' AND date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND date <= ?';
    params.push(dateTo);
  }

  sql += ' ORDER BY date DESC, source_name';
  return query<DBTrafficSourceAnalytics[]>(sql, params);
}

export async function getTrafficSourcesSummary(
  cabinetId: number,
  nmId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<any[]> {
  let sql = `
    SELECT
      source_name,
      SUM(open_card_count) as total_views,
      SUM(add_to_cart_count) as total_cart,
      SUM(orders_count) as total_orders,
      SUM(orders_sum) as total_orders_sum,
      SUM(buyouts_count) as total_buyouts,
      SUM(cancel_count) as total_cancels,
      ROUND(SUM(add_to_cart_count) / NULLIF(SUM(open_card_count), 0) * 100, 2) as conversion_to_cart,
      ROUND(SUM(orders_count) / NULLIF(SUM(add_to_cart_count), 0) * 100, 2) as conversion_to_order
    FROM traffic_source_analytics
    WHERE cabinet_id = ? AND nm_id = ?
  `;
  const params: any[] = [cabinetId, nmId];

  if (dateFrom) {
    sql += ' AND date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND date <= ?';
    params.push(dateTo);
  }

  sql += ' GROUP BY source_name ORDER BY total_views DESC';
  return query<any[]>(sql, params);
}
