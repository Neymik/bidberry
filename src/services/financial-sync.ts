import dayjs from 'dayjs';
import type { WBApiClient } from '../api/wb-client';
import * as monitoringRepo from '../db/monitoring-repository';
import * as repo from '../db/repository';

export async function syncFinancial(cabinetId: number, wbClient: WBApiClient): Promise<number> {
  const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
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

  // 3. Poll campaign budgets + save snapshots for hourly spend tracking
  try {
    const campaigns = await repo.getCampaigns(cabinetId);
    for (const campaign of campaigns) {
      try {
        const budgetData = await wbClient.getCampaignBudget(campaign.campaign_id);
        if (budgetData) {
          const budget = budgetData.budget ?? 0;
          const dailyBudget = budgetData.dailyBudget ?? 0;
          // Update campaign daily_budget
          await monitoringRepo.updateCampaignBudget(cabinetId, campaign.campaign_id, dailyBudget);
          // Save snapshot for hourly spend delta calculation
          await monitoringRepo.saveBudgetSnapshot(cabinetId, campaign.campaign_id, budget, dailyBudget);
          totalRecords++;
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

export async function canSyncNow(cabinetId: number): Promise<boolean> {
  const lastSync = await monitoringRepo.getLastFinancialSyncStatus(cabinetId);
  if (!lastSync?.lastSyncAt) return true;
  const lastTime = new Date(lastSync.lastSyncAt).getTime();
  return Date.now() - lastTime > 5 * 60 * 1000;
}
