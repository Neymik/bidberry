import { Hono } from 'hono';
import dayjs from 'dayjs';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';
import * as monitoringRepo from '../db/monitoring-repository';
import * as repo from '../db/repository';
import { syncFinancial, canSyncNow } from '../services/financial-sync';

const app = new Hono();

// === GET /api/monitoring/products ===
app.get('/api/monitoring/products', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const dateFrom = c.req.query('dateFrom') || dayjs().format('YYYY-MM-DD');
    const dateTo = c.req.query('dateTo') || dayjs().format('YYYY-MM-DD');
    const dateToEnd = dayjs(dateTo).add(1, 'day').format('YYYY-MM-DD');

    const products = await repo.getProducts(cabinetId);
    const allSettings = await monitoringRepo.getAllCpsSettings(cabinetId);
    const settingsMap = new Map(allSettings.map(s => [s.nm_id, s]));

    // Time boundaries
    const now = dayjs();
    const currentHourStart = now.startOf('hour').format('YYYY-MM-DD HH:mm:ss');
    const prevHourStart = now.subtract(1, 'hour').startOf('hour').format('YYYY-MM-DD HH:mm:ss');
    const todayStart = now.startOf('day').format('YYYY-MM-DD');
    const tomorrowStart = now.add(1, 'day').startOf('day').format('YYYY-MM-DD');

    const result = [];

    for (const product of products) {
      const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, product.nm_id);
      if (campaigns.length === 0) continue;

      const campaignIds = campaigns.map(c => c.campaign_id);
      const settings = settingsMap.get(product.nm_id);
      const buyoutPct = Number(settings?.buyout_pct ?? 80);

      // Daily = today only (not the entire date range)
      const spendDaily = await monitoringRepo.getSpendForCampaigns(cabinetId, campaignIds, todayStart, tomorrowStart);
      const ordersDaily = await monitoringRepo.getOrderCountForProduct(cabinetId, product.nm_id, todayStart, tomorrowStart);

      // Hourly spend and orders (previous completed hour)
      const spendHourly = await monitoringRepo.getSpendForCampaigns(cabinetId, campaignIds, prevHourStart, currentHourStart);
      const ordersHourly = await monitoringRepo.getOrderCountForProduct(cabinetId, product.nm_id, prevHourStart, currentHourStart);

      // CPS calculation
      const cpsDaily = ordersDaily > 0 && buyoutPct > 0
        ? Math.round(spendDaily / (ordersDaily * buyoutPct / 100) * 100) / 100
        : null;
      const cpsHourly = ordersHourly > 0 && buyoutPct > 0
        ? Math.round(spendHourly / (ordersHourly * buyoutPct / 100) * 100) / 100
        : null;

      result.push({
        nmId: product.nm_id,
        name: product.name || product.vendor_code || String(product.nm_id),
        campaigns: campaigns.slice(0, 2).map(c => ({
          id: c.campaign_id,
          name: c.name,
          status: c.status,
        })),
        campaignsTotal: campaigns.length,
        spendHourly,
        spendDaily,
        ordersHourly,
        ordersDaily,
        buyoutPct,
        cpsHourly,
        cpsDaily,
        plannedBudgetDaily: settings?.planned_budget_daily ?? null,
      });
    }

    // Get balance
    let balance = { balance: 0, bonus: 0 };
    try {
      const wbClient = getWBClientFromContext(c);
      balance = await wbClient.getBalance();
    } catch {}

    return c.json({ products: result, balance });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === GET /api/monitoring/products/:nmId/chart ===
app.get('/api/monitoring/products/:nmId/chart', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const nmId = parseInt(c.req.param('nmId'));
    const period = c.req.query('period') || 'daily';
    const dateFrom = c.req.query('dateFrom') || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = c.req.query('dateTo') || dayjs().format('YYYY-MM-DD');
    const dateToEnd = dayjs(dateTo).add(1, 'day').format('YYYY-MM-DD');

    const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, nmId);
    const campaignIds = campaigns.map(c => c.campaign_id);
    const settings = await monitoringRepo.getProductCpsSettings(cabinetId, nmId);
    const buyoutPct = Number(settings?.buyout_pct ?? 80);

    let spendData: { time: string; spend: number }[];
    let ordersData: { time: string; orders: number }[];

    if (period === 'hourly') {
      // WB /adv/v1/upd returns budget top-ups, not actual hourly spend.
      // Top-ups are lumpy (e.g. 2000 RUB at 06:00) causing false CPS spikes.
      // Fix: get daily spend totals and distribute evenly across hours that had orders.
      const dailySpend = await monitoringRepo.getDailySpend(cabinetId, campaignIds, dateFrom, dateToEnd);
      const hourlyOrders = await monitoringRepo.getHourlyOrders(cabinetId, nmId, dateFrom, dateToEnd);

      // Build daily spend map
      const dailySpendMap = new Map(dailySpend.map(d => [d.day, d.spend]));

      // Count hours with orders per day to distribute spend
      const hoursPerDay = new Map<string, number>();
      for (const h of hourlyOrders) {
        const day = h.hour.split(' ')[0];
        hoursPerDay.set(day, (hoursPerDay.get(day) || 0) + 1);
      }

      // Distribute daily spend evenly across active hours
      spendData = hourlyOrders.map(h => {
        const day = h.hour.split(' ')[0];
        const totalDaySpend = dailySpendMap.get(day) || 0;
        const activeHours = hoursPerDay.get(day) || 1;
        return { time: h.hour, spend: Math.round(totalDaySpend / activeHours * 100) / 100 };
      });
      ordersData = hourlyOrders.map(h => ({ time: h.hour, orders: h.orders }));
    } else {
      const dailySpend = await monitoringRepo.getDailySpend(cabinetId, campaignIds, dateFrom, dateToEnd);
      const dailyOrders = await monitoringRepo.getDailyOrders(cabinetId, nmId, dateFrom, dateToEnd);
      spendData = dailySpend.map(d => ({ time: d.day, spend: d.spend }));
      ordersData = dailyOrders.map(d => ({ time: d.day, orders: d.orders }));
    }

    // Merge spend + orders by time key, compute CPS
    const timeMap = new Map<string, { spend: number; orders: number }>();
    for (const s of spendData) timeMap.set(s.time, { spend: s.spend, orders: 0 });
    for (const o of ordersData) {
      const existing = timeMap.get(o.time) || { spend: 0, orders: 0 };
      existing.orders = o.orders;
      timeMap.set(o.time, existing);
    }

    const points: { time: string; spend: number; orders: number; cps: number | null }[] = [];
    for (const [time, data] of [...timeMap.entries()].sort()) {
      const cps = data.orders > 0 && buyoutPct > 0
        ? Math.round(data.spend / (data.orders * buyoutPct / 100) * 100) / 100
        : null;
      points.push({ time, spend: data.spend, orders: data.orders, cps });
    }

    return c.json({ points });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === PUT /api/monitoring/products/:nmId/settings ===
app.put('/api/monitoring/products/:nmId/settings', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const nmId = parseInt(c.req.param('nmId'));
    const body = await c.req.json<{ buyoutPct?: number; plannedBudgetDaily?: number | null }>();

    const buyoutPct = body.buyoutPct;
    if (buyoutPct !== undefined && (buyoutPct <= 0 || buyoutPct > 100)) {
      return c.json({ error: 'buyoutPct must be between 1 and 100' }, 400);
    }

    const current = await monitoringRepo.getProductCpsSettings(cabinetId, nmId);
    await monitoringRepo.upsertCpsSettings(
      cabinetId,
      nmId,
      buyoutPct ?? Number(current?.buyout_pct ?? 80),
      body.plannedBudgetDaily !== undefined ? body.plannedBudgetDaily : (current?.planned_budget_daily ?? null)
    );

    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === GET /api/monitoring/sync-status ===
app.get('/api/monitoring/sync-status', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const status = await monitoringRepo.getLastFinancialSyncStatus(cabinetId);
    return c.json(status || { lastSyncAt: null, status: 'never', recordsSynced: 0 });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === POST /api/sync/financial ===
app.post('/api/sync/financial', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const wbClient = getWBClientFromContext(c);

    if (!(await canSyncNow(cabinetId))) {
      return c.json({ error: 'Sync was performed less than 5 minutes ago' }, 429);
    }

    const importId = await repo.createImportRecord('financial-sync', undefined, cabinetId);
    try {
      const count = await syncFinancial(cabinetId, wbClient);
      await repo.updateImportRecord(importId, 'completed', count);
      return c.json({ success: true, synced: count });
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      return c.json({ error: error.message }, 500);
    }
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
