import { query, execute } from './connection';
import type { DBOrder, WBOrder } from '../types';

export async function upsertOrder(cabinetId: number, order: WBOrder): Promise<void> {
  const srid = order.srid || `fallback-${order.incomeID || 0}`;
  const sql = `
    INSERT INTO orders (cabinet_id, order_id, nm_id, srid, date_created, date_updated, warehouse_name, region,
      price, converted_price, discount_percent, spp, finished_price, price_with_disc,
      size, brand, subject, category, status, cancel_dt, is_cancel, sticker, gn_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      date_updated = VALUES(date_updated),
      nm_id = VALUES(nm_id),
      status = VALUES(status),
      cancel_dt = VALUES(cancel_dt),
      is_cancel = VALUES(is_cancel),
      finished_price = VALUES(finished_price),
      price_with_disc = VALUES(price_with_disc)
  `;

  // order_id kept for display only; dedup is via unique(cabinet_id, srid)
  const orderId = order.incomeID || 0;

  await execute(sql, [
    cabinetId,
    orderId,
    order.nmId,
    srid,
    new Date(order.date),
    new Date(order.lastChangeDate),
    order.warehouseName || null,
    order.regionName || null,
    order.totalPrice || 0,
    order.totalPrice || 0,
    order.discountPercent || 0,
    order.spp || 0,
    order.finishedPrice || 0,
    order.priceWithDisc || 0,
    order.techSize || null,
    order.brand || null,
    order.subject || null,
    order.category || null,
    order.isCancel ? 'cancelled' : 'delivered',
    order.cancelDate ? new Date(order.cancelDate) : null,
    order.isCancel || false,
    order.sticker || null,
    order.gNumber || null,
  ]);
}

export async function upsertOrdersBatch(cabinetId: number, orders: WBOrder[]): Promise<number> {
  let count = 0;
  for (const order of orders) {
    try {
      await upsertOrder(cabinetId, order);
      count++;
    } catch (e) {
      // Skip duplicates/errors
    }
  }
  return count;
}

export async function getOrders(
  cabinetId: number,
  dateFrom?: string,
  dateTo?: string,
  nmId?: number,
  limit = 500
): Promise<DBOrder[]> {
  let sql = 'SELECT *, DATEDIFF(date_updated, date_created) AS delivery_days FROM orders WHERE cabinet_id = ?';
  const params: any[] = [cabinetId];

  if (dateFrom) {
    sql += ' AND date_created >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND date_created <= ?';
    params.push(dateTo + ' 23:59:59');
  }
  if (nmId) {
    sql += ' AND nm_id = ?';
    params.push(nmId);
  }

  sql += ' ORDER BY date_created DESC LIMIT ?';
  params.push(limit);

  return query<DBOrder[]>(sql, params);
}

export async function getOrderStats(
  cabinetId: number,
  dateFrom?: string,
  dateTo?: string,
  nmId?: number
): Promise<{
  total_orders: number;
  total_sum: number;
  cancelled_count: number;
  cancelled_sum: number;
}> {
  let sql = `
    SELECT
      COUNT(*) as total_orders,
      COALESCE(SUM(price_with_disc), 0) as total_sum,
      SUM(CASE WHEN is_cancel = 1 THEN 1 ELSE 0 END) as cancelled_count,
      COALESCE(SUM(CASE WHEN is_cancel = 1 THEN price_with_disc ELSE 0 END), 0) as cancelled_sum
    FROM orders WHERE cabinet_id = ?
  `;
  const params: any[] = [cabinetId];

  if (dateFrom) {
    sql += ' AND date_created >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND date_created <= ?';
    params.push(dateTo + ' 23:59:59');
  }
  if (nmId) {
    sql += ' AND nm_id = ?';
    params.push(nmId);
  }

  const rows = await query<any[]>(sql, params);
  return rows[0] || { total_orders: 0, total_sum: 0, cancelled_count: 0, cancelled_sum: 0 };
}
