/**
 * Per-product daily WB ad spend, for the CPO comparison sheet.
 *
 * For each nmID we resolve its advertising campaigns (campaign_products) and sum
 * their daily spend. Two sources are combined per day, taking the larger — the
 * same max(expense, snapshot) reconciliation the daily/hourly CPO reports use:
 *   - campaign_expenses  (WB Advert expense feed, per advert_id)
 *   - campaign_budget_snapshots (budget deltas, per campaign_id)
 *
 * All day buckets are MSK wall-clock 'YYYY-MM-DD' (both source tables store MSK
 * strings), matching the manual 'Расчет CPO' sheet and the phone DB.
 *
 * This is only meaningful when a product's campaigns are dedicated to it (one
 * nmID per campaign); for shared campaigns the spend would be over-attributed.
 * The Штаны products tracked by the sheet have dedicated campaigns.
 */
import * as monitoringRepo from '../db/monitoring-repository';

export interface ProductDailySpend {
  // nmId (as string) -> { 'YYYY-MM-DD': spend_rubles }
  [nmId: string]: { [day: string]: number };
}

/**
 * Build the per-nmId per-day spend map over [dayFrom, dayTo] inclusive (MSK days).
 * @param dayFrom 'YYYY-MM-DD' inclusive
 * @param dayTo   'YYYY-MM-DD' inclusive
 */
export async function getProductDailySpend(
  cabinetId: number,
  nmIds: number[],
  dayFrom: string,
  dayTo: string
): Promise<ProductDailySpend> {
  const dateFrom = `${dayFrom} 00:00:00`;
  // exclusive upper bound = start of the day after dayTo
  const dateTo = `${dayTo} 23:59:59`;

  const out: ProductDailySpend = {};
  for (const nmId of nmIds) {
    const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, nmId);
    const campaignIds = campaigns.map(c => c.campaign_id);

    const expense = await monitoringRepo.getDailySpend(cabinetId, campaignIds, dateFrom, dateTo);
    const snapshot = await monitoringRepo.getDailySpendFromSnapshots(cabinetId, campaignIds, dateFrom, dateTo);

    const byDay: { [day: string]: number } = {};
    for (const { day, spend } of expense) byDay[day] = spend;
    for (const { day, spend } of snapshot) byDay[day] = Math.max(byDay[day] || 0, spend);

    out[String(nmId)] = Object.fromEntries(
      Object.entries(byDay).map(([day, spend]) => [day, Math.round(spend)])
    );
  }
  return out;
}
