import { getWBClient } from '../api/wb-client';
import * as ordersRepo from '../db/orders-repository';
import dayjs from 'dayjs';

export async function syncOrders(dateFrom?: string): Promise<number> {
  const client = getWBClient();
  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');

  const orders = await client.getOrders(from);
  return ordersRepo.upsertOrdersBatch(orders);
}

export async function getOrders(dateFrom?: string, dateTo?: string, nmId?: number) {
  return ordersRepo.getOrders(dateFrom, dateTo, nmId);
}

export async function getOrderStats(dateFrom?: string, dateTo?: string, nmId?: number) {
  return ordersRepo.getOrderStats(dateFrom, dateTo, nmId);
}
