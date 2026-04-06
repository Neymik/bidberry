import { Hono } from 'hono';
import dayjs from 'dayjs';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';
import * as monitoringRepo from '../db/monitoring-repository';
import * as repo from '../db/repository';
import { syncFinancial, canSyncNow } from '../services/financial-sync';
import * as ordersService from '../services/orders-service';

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

    // Time boundaries in Moscow (UTC+3), converted to UTC for DB queries
    const MSK = 3;
    const now = dayjs();
    const nowMsk = now.add(MSK, 'hour');
    const mskToday = nowMsk.startOf('day');
    const mskCurrentHour = nowMsk.startOf('hour');
    const todayStart = mskToday.subtract(MSK, 'hour').format('YYYY-MM-DD HH:mm:ss');
    const tomorrowStart = mskToday.add(1, 'day').subtract(MSK, 'hour').format('YYYY-MM-DD HH:mm:ss');
    const currentHourStart = mskCurrentHour.subtract(MSK, 'hour').format('YYYY-MM-DD HH:mm:ss');
    const prevHourStart = mskCurrentHour.subtract(1, 'hour').subtract(MSK, 'hour').format('YYYY-MM-DD HH:mm:ss');

    // Pre-filter monitored products and fetch accurate order counts from WB Analytics API
    const monitoredProducts: { product: typeof products[0]; campaignIds: number[]; campaigns: any[] }[] = [];
    for (const product of products) {
      const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, product.nm_id);
      if (campaigns.length === 0) continue;
      monitoredProducts.push({ product, campaignIds: campaigns.map(c => c.campaign_id), campaigns });
    }

    // Fetch accurate daily order counts from WB Analytics sales-funnel API
    // (Statistics API /supplier/orders misses ~14% of orders)
    const analyticsOrdersMap = new Map<number, number>();
    if (monitoredProducts.length > 0) {
      try {
        const wbClient = getWBClientFromContext(c);
        const todayMsk = mskToday.format('YYYY-MM-DD');
        const nmIds = monitoredProducts.map(m => m.product.nm_id);
        const analytics = await wbClient.getProductAnalytics(nmIds, todayMsk, todayMsk);
        for (const a of analytics) {
          analyticsOrdersMap.set(a.nmID, a.statistics.selectedPeriod.ordersCount);
        }
      } catch (e) {
        // Fallback to orders table if analytics API fails
        console.error('[Monitoring] Failed to fetch analytics order counts, using orders table:', e);
      }
    }

    const result = [];

    for (const { product, campaignIds, campaigns } of monitoredProducts) {
      const settings = settingsMap.get(product.nm_id);
      const buyoutPct = Number(settings?.buyout_pct ?? 50);
      const manualScalePct = settings?.order_scale_pct != null ? Number(settings.order_scale_pct) : null;

      // Raw orders from Statistics API (orders table)
      const spendDaily = await monitoringRepo.getSpendForCampaigns(cabinetId, campaignIds, todayStart, tomorrowStart);
      const rawOrdersDaily = await monitoringRepo.getOrderCountForProduct(cabinetId, product.nm_id, todayStart, tomorrowStart);
      const analyticsDaily = analyticsOrdersMap.get(product.nm_id) ?? null;

      // Auto scale factor from analytics/statistics ratio
      const orderScaleAuto = rawOrdersDaily > 0 && analyticsDaily != null && analyticsDaily > rawOrdersDaily
        ? Math.round(analyticsDaily / rawOrdersDaily * 100)
        : 100;

      // Use manual override if set, otherwise auto
      const scalePct = manualScalePct ?? orderScaleAuto;
      const scaleFactor = scalePct / 100;

      const ordersDaily = Math.round(rawOrdersDaily * scaleFactor);

      // Hourly spend from real budget snapshots, orders from orders table scaled
      const hourlySpendData = await monitoringRepo.getHourlySpendFromSnapshots(cabinetId, campaignIds, prevHourStart, currentHourStart);
      const spendHourly = hourlySpendData.reduce((sum, h) => sum + h.spend, 0);
      const rawOrdersHourly = await monitoringRepo.getOrderCountForProduct(cabinetId, product.nm_id, prevHourStart, currentHourStart);
      const ordersHourly = Math.round(rawOrdersHourly * scaleFactor);

      // CPS = spend / (orders * buyout%), CPO = spend / orders
      const cpsDaily = ordersDaily > 0 && buyoutPct > 0
        ? Math.round(spendDaily / (ordersDaily * buyoutPct / 100) * 100) / 100
        : null;
      const cpsHourly = ordersHourly > 0 && buyoutPct > 0
        ? Math.round(spendHourly / (ordersHourly * buyoutPct / 100) * 100) / 100
        : null;
      const cpoDaily = ordersDaily > 0
        ? Math.round(spendDaily / ordersDaily * 100) / 100
        : null;
      const cpoHourly = ordersHourly > 0
        ? Math.round(spendHourly / ordersHourly * 100) / 100
        : null;

      result.push({
        nmId: product.nm_id,
        vendorCode: product.vendor_code || '',
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
        ordersRaw: rawOrdersDaily,
        buyoutPct,
        orderScalePct: manualScalePct,
        orderScaleAuto,
        cpsHourly,
        cpsDaily,
        cpoHourly,
        cpoDaily,
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
    const MSK = 3;
    // dateFrom/dateTo are MSK dates from UI. Convert to UTC for DB queries.
    const dateFrom = c.req.query('dateFrom') || dayjs().add(MSK, 'hour').subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = c.req.query('dateTo') || dayjs().add(MSK, 'hour').format('YYYY-MM-DD');
    const dateFromUtc = dayjs(dateFrom).subtract(MSK, 'hour').format('YYYY-MM-DD HH:mm:ss');
    const dateToEndUtc = dayjs(dateTo).add(1, 'day').subtract(MSK, 'hour').format('YYYY-MM-DD HH:mm:ss');

    const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, nmId);
    const campaignIds = campaigns.map(c => c.campaign_id);
    const settings = await monitoringRepo.getProductCpsSettings(cabinetId, nmId);
    const buyoutPct = Number(settings?.buyout_pct ?? 50);

    let spendData: { time: string; spend: number }[];
    let ordersData: { time: string; orders: number }[];

    if (period === 'hourly') {
      // Use real hourly spend from budget snapshots (polled every 15 min).
      const hourlySpend = await monitoringRepo.getHourlySpendFromSnapshots(cabinetId, campaignIds, dateFromUtc, dateToEndUtc);
      const hourlyOrders = await monitoringRepo.getHourlyOrders(cabinetId, nmId, dateFromUtc, dateToEndUtc);
      spendData = hourlySpend.map(h => ({ time: h.hour, spend: h.spend }));

      // Scale hourly orders using accurate daily total from product_analytics
      // (Statistics API orders table has ~15-25% gap vs real WB data)
      const rawTotal = hourlyOrders.reduce((s, h) => s + h.orders, 0);
      let scaleFactor = 1;
      if (rawTotal > 0) {
        const analyticsRows = await repo.getProductAnalyticsByDate(cabinetId, nmId, dateFrom, dateTo);
        if (analyticsRows.length > 0) {
          const analyticsTotal = analyticsRows.reduce((s, r) => s + Number(r.orders_count || 0), 0);
          if (analyticsTotal > rawTotal) scaleFactor = analyticsTotal / rawTotal;
        }
      }
      ordersData = hourlyOrders.map(h => ({
        time: h.hour,
        orders: Math.round(h.orders * scaleFactor),
      }));
    } else {
      const dailySpend = await monitoringRepo.getDailySpend(cabinetId, campaignIds, dateFromUtc, dateToEndUtc);
      // Use accurate daily counts from product_analytics when available
      const analyticsRows = await repo.getProductAnalyticsByDate(cabinetId, nmId, dateFrom, dateTo);
      const analyticsMap = new Map(analyticsRows.map(r => {
        const dateStr = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
        return [dateStr, Number(r.orders_count || 0)];
      }));
      const dailyOrders = await monitoringRepo.getDailyOrders(cabinetId, nmId, dateFromUtc, dateToEndUtc);
      spendData = dailySpend.map(d => ({ time: d.day, spend: d.spend }));
      ordersData = dailyOrders.map(d => ({
        time: d.day,
        orders: analyticsMap.get(d.day) ?? d.orders,
      }));
    }

    // Merge spend + orders by time key, compute CPS
    const timeMap = new Map<string, { spend: number; orders: number }>();
    for (const s of spendData) timeMap.set(s.time, { spend: s.spend, orders: 0 });
    for (const o of ordersData) {
      const existing = timeMap.get(o.time) || { spend: 0, orders: 0 };
      existing.orders = o.orders;
      timeMap.set(o.time, existing);
    }

    const points: { time: string; spend: number; orders: number; cps: number | null; cpo: number | null }[] = [];
    for (const [time, data] of [...timeMap.entries()].sort()) {
      const cps = data.orders > 0 && buyoutPct > 0
        ? Math.round(data.spend / (data.orders * buyoutPct / 100) * 100) / 100
        : null;
      const cpo = data.orders > 0
        ? Math.round(data.spend / data.orders * 100) / 100
        : null;
      points.push({ time, spend: data.spend, orders: data.orders, cps, cpo });
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
    const body = await c.req.json<{ buyoutPct?: number; plannedBudgetDaily?: number | null; orderScalePct?: number | null }>();

    const buyoutPct = body.buyoutPct;
    if (buyoutPct !== undefined && (buyoutPct <= 0 || buyoutPct > 100)) {
      return c.json({ error: 'buyoutPct must be between 1 and 100' }, 400);
    }
    if (body.orderScalePct !== undefined && body.orderScalePct !== null && (body.orderScalePct < 100 || body.orderScalePct > 300)) {
      return c.json({ error: 'orderScalePct must be between 100 and 300, or null for auto' }, 400);
    }

    const current = await monitoringRepo.getProductCpsSettings(cabinetId, nmId);
    const orderScalePctArg = body.orderScalePct !== undefined
      ? body.orderScalePct  // null = reset to auto, number = manual override
      : undefined;          // undefined = don't touch
    await monitoringRepo.upsertCpsSettings(
      cabinetId,
      nmId,
      buyoutPct ?? Number(current?.buyout_pct ?? 50),
      body.plannedBudgetDaily !== undefined ? body.plannedBudgetDaily : (current?.planned_budget_daily ?? null),
      orderScalePctArg as any
    );

    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === POST /api/sync/orders-fast ===
app.post('/api/sync/orders-fast', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const wbClient = getWBClientFromContext(c);

    // Rate limit: check last orders-sync-fast within 5 min
    const lastSync = await monitoringRepo.getLastSyncByType(cabinetId, 'orders-sync-fast');
    if (lastSync?.started_at) {
      const minAgo = (Date.now() - new Date(lastSync.started_at).getTime()) / 60000;
      if (minAgo < 5) {
        return c.json({ error: 'Orders sync was performed less than 5 minutes ago' }, 429);
      }
    }

    const importId = await repo.createImportRecord('orders-sync-fast', undefined, cabinetId);
    try {
      const count = await ordersService.syncOrdersFast(cabinetId, wbClient);
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
