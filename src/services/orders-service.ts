import * as ordersRepo from '../db/orders-repository';
import type { WBApiClient } from '../api/wb-client';
import dayjs from 'dayjs';

export async function syncOrders(cabinetId: number, wbClient: WBApiClient, dateFrom?: string): Promise<number> {
  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const orders = await wbClient.getOrders(from);
  return ordersRepo.upsertOrdersBatch(cabinetId, orders);
}

export async function syncOrdersFast(cabinetId: number, wbClient: WBApiClient): Promise<number> {
  const from = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const orders = await wbClient.getOrders(from);
  return ordersRepo.upsertOrdersBatch(cabinetId, orders);
}

export async function getOrders(cabinetId: number, dateFrom?: string, dateTo?: string, nmId?: number) {
  return ordersRepo.getOrders(cabinetId, dateFrom, dateTo, nmId);
}

export async function getOrderStats(cabinetId: number, dateFrom?: string, dateTo?: string, nmId?: number) {
  return ordersRepo.getOrderStats(cabinetId, dateFrom, dateTo, nmId);
}
