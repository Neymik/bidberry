import { getWBClient } from '../api/wb-client';
import * as financialRepo from '../db/financial-repository';
import * as repo from '../db/repository';
import type { PnLSummary, UnitEconomics, DBSalesReport, DBProductCost } from '../types';

export async function syncSalesReport(dateFrom: string, dateTo: string): Promise<number> {
  const wbClient = getWBClient();
  const report = await wbClient.getSalesReport(dateFrom, dateTo);

  let count = 0;
  if (Array.isArray(report)) {
    for (const item of report) {
      // Ensure product exists
      if (item.nm_id || item.nmId) {
        const nmId = item.nm_id || item.nmId;
        await repo.upsertProduct({ nmId });
        await financialRepo.upsertSalesReport({
          nm_id: nmId,
          date: item.date || item.sale_dt || dateFrom,
          quantity: item.quantity || item.shk_id ? 1 : 0,
          revenue: item.retail_amount || item.revenue || 0,
          returns_count: item.return_amount ? 1 : 0,
          returns_sum: item.return_amount || 0,
          wb_commission: item.commission_percent ? (item.retail_amount || 0) * item.commission_percent / 100 : (item.ppvz_kvw_prc_base || 0),
          logistics_cost: item.delivery_rub || 0,
          storage_cost: item.storage_fee || 0,
          penalties: item.penalty || 0,
          additional_charges: item.additional_payment || 0,
          net_payment: item.ppvz_for_pay || item.net_payment || 0,
        });
        count++;
      }
    }
  }

  return count;
}

export async function getPnL(dateFrom?: string, dateTo?: string): Promise<PnLSummary[]> {
  return financialRepo.getPnLSummary(dateFrom, dateTo);
}

export async function getProductPnL(nmId: number, dateFrom?: string, dateTo?: string): Promise<PnLSummary | null> {
  return financialRepo.getPnLForProduct(nmId, dateFrom, dateTo);
}

export async function getUnitEconomics(nmId: number): Promise<UnitEconomics | null> {
  return financialRepo.getUnitEconomics(nmId);
}

export async function updateProductCosts(nmId: number, costs: {
  cost_price?: number;
  logistics_cost?: number;
  commission_pct?: number;
  storage_cost?: number;
  packaging_cost?: number;
  additional_cost?: number;
}): Promise<void> {
  return financialRepo.upsertProductCosts(nmId, costs);
}

export async function getProductCosts(nmId: number): Promise<DBProductCost | null> {
  return financialRepo.getProductCosts(nmId);
}

export async function getSalesReports(nmId: number, dateFrom?: string, dateTo?: string): Promise<DBSalesReport[]> {
  return financialRepo.getSalesReports(nmId, dateFrom, dateTo);
}
