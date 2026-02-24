import { getWBClient } from '../api/wb-client';
import * as stockRepo from '../db/stock-repository';
import dayjs from 'dayjs';

export async function syncStocks(): Promise<number> {
  const client = getWBClient();
  // WB stocks API requires dateFrom — use yesterday to get current stocks
  const dateFrom = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const stocks = await client.getStocks(dateFrom);
  return stockRepo.upsertStocksBatch(stocks);
}

export async function getStocksByNmId(nmId: number, snapshotDate?: string) {
  return stockRepo.getStocksByNmId(nmId, snapshotDate);
}

export async function getStocksSummary(snapshotDate?: string) {
  return stockRepo.getStocksSummary(snapshotDate);
}

export async function getLatestSnapshotDate() {
  return stockRepo.getLatestSnapshotDate();
}
