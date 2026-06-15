/**
 * Hourly CPO (cost-per-order) series for a cabinet.
 *
 * Mirrors generateCabinetReport's data sources and conventions, but broken
 * down per hour over the last N hours instead of one aggregate window:
 *   - ORDERS: phone scraping DB (authoritative), active orders only, by hour.
 *   - SPEND:  bidberry tables (budget snapshots + advert expenses), by hour;
 *             per hour we take max(snapshot, expense) like the daily report.
 *   - CPO = spend / orders per hour (null when there are no orders).
 *
 * All DATETIME comparisons use MSK wall-clock strings, matching how both the
 * MySQL tables and the phone DB's `date_parsed` are stored.
 */
import dayjs from 'dayjs';
import * as monitoringRepo from '../db/monitoring-repository';
import * as cabinetsRepo from '../db/cabinets-repository';
import { getPhoneHourlyTotals } from './wbpartners-phone-db';

const MSK_OFFSET_HOURS = 3;
const MAX_HOURS = 48;

export interface CpoHourPoint {
  hour: string;        // "YYYY-MM-DD HH:00:00" (MSK)
  label: string;       // "HH:00"
  orders: number;
  spend: number;       // rubles
  cpo: number | null;  // rubles per order, null if no orders
}

export interface CpoHourlySeries {
  cabinetId: number;
  cabinetName: string;
  hours: number;
  generatedAt: string; // MSK "YYYY-MM-DD HH:mm:ss"
  points: CpoHourPoint[];
  totals: { orders: number; spend: number; cpo: number | null };
}

/**
 * Build the hourly CPO series ending at the current (in-progress) MSK hour.
 * Returns null if the cabinet doesn't exist.
 */
export async function getHourlyCpoSeries(
  cabinetId: number,
  hours = 12
): Promise<CpoHourlySeries | null> {
  const cabinet = await cabinetsRepo.getCabinetById(cabinetId);
  if (!cabinet) return null;

  const h = Math.max(1, Math.min(MAX_HOURS, Math.floor(hours) || 12));

  const nowMsk = dayjs().add(MSK_OFFSET_HOURS, 'hour');
  const curHour = nowMsk.startOf('hour');
  const startMsk = curHour.subtract(h - 1, 'hour');
  const endMsk = curHour.add(1, 'hour'); // exclusive — includes the current partial hour

  const startSql = startMsk.format('YYYY-MM-DD HH:mm:ss');
  const endSql = endMsk.format('YYYY-MM-DD HH:mm:ss');
  const startIso = startSql.replace(' ', 'T');
  const endIso = endSql.replace(' ', 'T');

  const phoneHours = getPhoneHourlyTotals(startIso, endIso);
  const snapHours = await monitoringRepo.getCabinetHourlySpendFromSnapshots(cabinetId, startSql, endSql);
  const expHours = await monitoringRepo.getCabinetHourlySpendFromExpenses(cabinetId, startSql, endSql);

  const ordersByHour = new Map<string, number>(phoneHours.map(r => [r.hour, r.orders]));
  const snapByHour = new Map<string, number>(snapHours.map(r => [r.hour, r.spend]));
  const expByHour = new Map<string, number>(expHours.map(r => [r.hour, r.spend]));

  const points: CpoHourPoint[] = [];
  let totalOrders = 0;
  let totalSpend = 0;
  for (let i = 0; i < h; i++) {
    const bucket = startMsk.add(i, 'hour');
    const key = bucket.format('YYYY-MM-DD HH:00:00');
    const orders = ordersByHour.get(key) || 0;
    const spend = Math.max(snapByHour.get(key) || 0, expByHour.get(key) || 0);
    const cpo = orders > 0 ? Math.round(spend / orders) : null;
    points.push({ hour: key, label: bucket.format('HH:00'), orders, spend: Math.round(spend), cpo });
    totalOrders += orders;
    totalSpend += spend;
  }

  const totalCpo = totalOrders > 0 ? Math.round(totalSpend / totalOrders) : null;
  return {
    cabinetId,
    cabinetName: cabinet.name,
    hours: h,
    generatedAt: nowMsk.format('YYYY-MM-DD HH:mm:ss'),
    points,
    totals: { orders: totalOrders, spend: Math.round(totalSpend), cpo: totalCpo },
  };
}
