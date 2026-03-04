import * as stockRepo from '../db/stock-repository';
import type { WBApiClient } from '../api/wb-client';
import dayjs from 'dayjs';

export async function syncStocks(cabinetId: number, wbClient: WBApiClient): Promise<number> {
  // WB stocks API requires dateFrom — use yesterday to get current stocks
  const dateFrom = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const stocks = await wbClient.getStocks(dateFrom);
  return stockRepo.upsertStocksBatch(cabinetId, stocks);
}

export async function getStocksByNmId(cabinetId: number, nmId: number, snapshotDate?: string) {
  return stockRepo.getStocksByNmId(cabinetId, nmId, snapshotDate);
}

export async function getStocksSummary(cabinetId: number, snapshotDate?: string) {
  return stockRepo.getStocksSummary(cabinetId, snapshotDate);
}

export async function getLatestSnapshotDate(cabinetId: number) {
  return stockRepo.getLatestSnapshotDate(cabinetId);
}
