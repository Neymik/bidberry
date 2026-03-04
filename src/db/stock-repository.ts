import { query, execute } from './connection';
import type { DBStockSnapshot, WBStock } from '../types';
import dayjs from 'dayjs';

export async function upsertStockSnapshot(cabinetId: number, stock: WBStock, snapshotDate: string): Promise<void> {
  const sql = `
    INSERT INTO stock_snapshots (cabinet_id, nm_id, last_change_date, supplier_article, tech_size, barcode,
      quantity, in_way_to_client, in_way_from_client, quantity_full, warehouse_name,
      category, subject, brand, sc_code, price, discount, snapshot_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      last_change_date = VALUES(last_change_date),
      quantity = VALUES(quantity),
      in_way_to_client = VALUES(in_way_to_client),
      in_way_from_client = VALUES(in_way_from_client),
      quantity_full = VALUES(quantity_full),
      price = VALUES(price),
      discount = VALUES(discount)
  `;

  await execute(sql, [
    cabinetId,
    stock.nmId,
    stock.lastChangeDate ? new Date(stock.lastChangeDate) : null,
    stock.supplierArticle || null,
    stock.techSize || null,
    stock.barcode || null,
    stock.quantity || 0,
    stock.inWayToClient || 0,
    stock.inWayFromClient || 0,
    stock.quantityFull || 0,
    stock.warehouseName || null,
    stock.category || null,
    stock.subject || null,
    stock.brand || null,
    stock.SCCode || null,
    stock.Price || 0,
    stock.Discount || 0,
    snapshotDate,
  ]);
}

export async function upsertStocksBatch(cabinetId: number, stocks: WBStock[]): Promise<number> {
  const snapshotDate = dayjs().format('YYYY-MM-DD');
  let count = 0;
  for (const stock of stocks) {
    try {
      await upsertStockSnapshot(cabinetId, stock, snapshotDate);
      count++;
    } catch (e) {
      // Skip duplicates/errors
    }
  }
  return count;
}

export async function getStocksByNmId(cabinetId: number, nmId: number, snapshotDate?: string): Promise<DBStockSnapshot[]> {
  let sql = 'SELECT * FROM stock_snapshots WHERE cabinet_id = ? AND nm_id = ?';
  const params: any[] = [cabinetId, nmId];

  if (snapshotDate) {
    sql += ' AND snapshot_date = ?';
    params.push(snapshotDate);
  } else {
    sql += ' AND snapshot_date = (SELECT MAX(snapshot_date) FROM stock_snapshots WHERE cabinet_id = ? AND nm_id = ?)';
    params.push(cabinetId, nmId);
  }

  sql += ' ORDER BY warehouse_name, tech_size';
  return query<DBStockSnapshot[]>(sql, params);
}

export async function getStocksSummary(cabinetId: number, snapshotDate?: string): Promise<any[]> {
  const dateCondition = snapshotDate
    ? 'snapshot_date = ?'
    : 'snapshot_date = (SELECT MAX(snapshot_date) FROM stock_snapshots WHERE cabinet_id = ?)';
  const params: any[] = [cabinetId];
  if (snapshotDate) {
    params.push(snapshotDate);
  } else {
    params.push(cabinetId);
  }

  const sql = `
    SELECT
      nm_id,
      supplier_article,
      brand,
      subject,
      SUM(quantity) as total_quantity,
      SUM(in_way_to_client) as total_in_way_to_client,
      SUM(in_way_from_client) as total_in_way_from_client,
      SUM(quantity_full) as total_quantity_full,
      COUNT(DISTINCT warehouse_name) as warehouses_count,
      COUNT(DISTINCT tech_size) as sizes_count
    FROM stock_snapshots
    WHERE cabinet_id = ? AND ${dateCondition}
    GROUP BY nm_id, supplier_article, brand, subject
    ORDER BY nm_id
  `;

  return query<any[]>(sql, params);
}

export async function getLatestSnapshotDate(cabinetId: number): Promise<string | null> {
  const rows = await query<any[]>('SELECT MAX(snapshot_date) as latest FROM stock_snapshots WHERE cabinet_id = ?', [cabinetId]);
  return rows[0]?.latest || null;
}
