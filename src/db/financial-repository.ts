import { query, execute } from './connection';
import type { DBProductCost, DBSalesReport, PnLSummary, UnitEconomics } from '../types';

// === PRODUCT COSTS ===

export async function getProductCosts(cabinetId: number, nmId: number): Promise<DBProductCost | null> {
  const rows = await query<DBProductCost[]>(
    'SELECT * FROM product_costs WHERE cabinet_id = ? AND nm_id = ?',
    [cabinetId, nmId]
  );
  return rows[0] || null;
}

export async function upsertProductCosts(cabinetId: number, nmId: number, costs: {
  cost_price?: number;
  logistics_cost?: number;
  commission_pct?: number;
  storage_cost?: number;
  packaging_cost?: number;
  additional_cost?: number;
}): Promise<void> {
  await execute(
    `INSERT INTO product_costs (cabinet_id, nm_id, cost_price, logistics_cost, commission_pct, storage_cost, packaging_cost, additional_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       cost_price = COALESCE(VALUES(cost_price), cost_price),
       logistics_cost = COALESCE(VALUES(logistics_cost), logistics_cost),
       commission_pct = COALESCE(VALUES(commission_pct), commission_pct),
       storage_cost = COALESCE(VALUES(storage_cost), storage_cost),
       packaging_cost = COALESCE(VALUES(packaging_cost), packaging_cost),
       additional_cost = COALESCE(VALUES(additional_cost), additional_cost)`,
    [cabinetId, nmId, costs.cost_price ?? 0, costs.logistics_cost ?? 0, costs.commission_pct ?? 0, costs.storage_cost ?? 0, costs.packaging_cost ?? 0, costs.additional_cost ?? 0]
  );
}

export async function getAllProductCosts(cabinetId: number): Promise<DBProductCost[]> {
  return query<DBProductCost[]>('SELECT * FROM product_costs WHERE cabinet_id = ? ORDER BY nm_id', [cabinetId]);
}

// === SALES REPORTS ===

export async function upsertSalesReport(cabinetId: number, report: {
  nm_id: number;
  date: string;
  quantity?: number;
  revenue?: number;
  returns_count?: number;
  returns_sum?: number;
  wb_commission?: number;
  logistics_cost?: number;
  storage_cost?: number;
  penalties?: number;
  additional_charges?: number;
  net_payment?: number;
}): Promise<void> {
  await execute(
    `INSERT INTO sales_reports (cabinet_id, nm_id, date, quantity, revenue, returns_count, returns_sum, wb_commission, logistics_cost, storage_cost, penalties, additional_charges, net_payment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       quantity = VALUES(quantity),
       revenue = VALUES(revenue),
       returns_count = VALUES(returns_count),
       returns_sum = VALUES(returns_sum),
       wb_commission = VALUES(wb_commission),
       logistics_cost = VALUES(logistics_cost),
       storage_cost = VALUES(storage_cost),
       penalties = VALUES(penalties),
       additional_charges = VALUES(additional_charges),
       net_payment = VALUES(net_payment)`,
    [cabinetId, report.nm_id, report.date, report.quantity ?? 0, report.revenue ?? 0, report.returns_count ?? 0, report.returns_sum ?? 0, report.wb_commission ?? 0, report.logistics_cost ?? 0, report.storage_cost ?? 0, report.penalties ?? 0, report.additional_charges ?? 0, report.net_payment ?? 0]
  );
}

export async function getSalesReports(cabinetId: number, nmId: number, dateFrom?: string, dateTo?: string): Promise<DBSalesReport[]> {
  let sql = 'SELECT * FROM sales_reports WHERE cabinet_id = ? AND nm_id = ?';
  const params: any[] = [cabinetId, nmId];
  if (dateFrom) { sql += ' AND date >= ?'; params.push(dateFrom); }
  if (dateTo) { sql += ' AND date <= ?'; params.push(dateTo); }
  sql += ' ORDER BY date DESC';
  return query<DBSalesReport[]>(sql, params);
}

// === P&L ===

export async function getPnLSummary(cabinetId: number, dateFrom?: string, dateTo?: string): Promise<PnLSummary[]> {
  let sql = `
    SELECT
      p.nm_id, p.name, p.brand,
      COALESCE(SUM(sr.revenue), 0) as total_revenue,
      COALESCE(SUM(sr.wb_commission), 0) as total_wb_commission,
      COALESCE(SUM(sr.logistics_cost), 0) as total_logistics,
      COALESCE(SUM(sr.storage_cost), 0) as total_storage,
      COALESCE(SUM(sr.penalties), 0) as total_penalties,
      COALESCE(SUM(sr.net_payment), 0) as total_net_payment,
      COALESCE(pc.cost_price, 0) as cost_price,
      COALESCE(SUM(sr.quantity), 0) as total_quantity,
      COALESCE(SUM(sr.returns_count), 0) as total_returns,
      COALESCE(SUM(sr.net_payment), 0) - COALESCE(pc.cost_price, 0) * COALESCE(SUM(sr.quantity), 0) as estimated_profit
    FROM products p
    LEFT JOIN sales_reports sr ON p.nm_id = sr.nm_id AND p.cabinet_id = sr.cabinet_id
    LEFT JOIN product_costs pc ON p.nm_id = pc.nm_id AND p.cabinet_id = pc.cabinet_id
    WHERE p.cabinet_id = ?
  `;
  const params: any[] = [cabinetId];
  if (dateFrom) { sql += ' AND sr.date >= ?'; params.push(dateFrom); }
  if (dateTo) { sql += ' AND sr.date <= ?'; params.push(dateTo); }
  sql += ' GROUP BY p.nm_id, p.name, p.brand, pc.cost_price ORDER BY estimated_profit DESC';
  return query<PnLSummary[]>(sql, params);
}

export async function getPnLForProduct(cabinetId: number, nmId: number, dateFrom?: string, dateTo?: string): Promise<PnLSummary | null> {
  const all = await getPnLSummary(cabinetId, dateFrom, dateTo);
  return all.find(p => p.nm_id === nmId) || null;
}

export async function getUnitEconomics(cabinetId: number, nmId: number): Promise<UnitEconomics | null> {
  const costs = await getProductCosts(cabinetId, nmId);
  const product = await query<any[]>('SELECT * FROM products WHERE cabinet_id = ? AND nm_id = ?', [cabinetId, nmId]);
  if (!product[0]) return null;

  const salesRows = await query<any[]>(
    'SELECT COALESCE(AVG(revenue / NULLIF(quantity, 0)), 0) as avg_revenue_per_unit, COALESCE(AVG(wb_commission / NULLIF(quantity, 0)), 0) as avg_commission, COALESCE(AVG(logistics_cost / NULLIF(quantity, 0)), 0) as avg_logistics FROM sales_reports WHERE cabinet_id = ? AND nm_id = ? AND quantity > 0',
    [cabinetId, nmId]
  );
  const avgSales = salesRows[0] || {};

  const costPrice = costs?.cost_price ?? 0;
  const wbCommission = avgSales.avg_commission ?? 0;
  const logistics = avgSales.avg_logistics ?? (costs?.logistics_cost ?? 0);
  const storage = costs?.storage_cost ?? 0;
  const packaging = costs?.packaging_cost ?? 0;
  const additional = costs?.additional_cost ?? 0;
  const revenuePerUnit = avgSales.avg_revenue_per_unit ?? 0;

  const totalCost = costPrice + wbCommission + logistics + storage + packaging + additional;
  const profitPerUnit = revenuePerUnit - totalCost;
  const marginPct = revenuePerUnit > 0 ? (profitPerUnit / revenuePerUnit) * 100 : 0;
  const roiPct = totalCost > 0 ? (profitPerUnit / totalCost) * 100 : 0;

  return {
    nm_id: nmId,
    name: product[0].name,
    revenue_per_unit: revenuePerUnit,
    cost_price: costPrice,
    wb_commission: wbCommission,
    logistics,
    storage,
    packaging,
    additional,
    total_cost: totalCost,
    profit_per_unit: profitPerUnit,
    margin_pct: Math.round(marginPct * 100) / 100,
    roi_pct: Math.round(roiPct * 100) / 100,
  };
}
