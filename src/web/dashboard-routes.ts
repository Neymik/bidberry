import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import dayjs from 'dayjs';
import * as repo from '../db/repository';
import { checkConnection } from '../db/connection';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';

const app = new Hono();

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

app.get('/api/health', async (c) => {
  const dbConnected = await checkConnection();
  let wbConnected = false;
  try {
    const wbClient = getWBClientFromContext(c);
    wbConnected = await wbClient.checkConnection();
  } catch { /* no cabinet selected */ }
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      database: dbConnected ? 'connected' : 'disconnected',
      wildberries: wbConnected ? 'connected' : 'disconnected',
    },
  });
});

app.get('/api/dashboard', zValidator('query', dateRangeSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo } = c.req.valid('query');
  const from = dateFrom || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const to = dateTo || dayjs().format('YYYY-MM-DD');
  try {
    const [summary, dailyStats, campaigns] = await Promise.all([
      repo.getAnalyticsSummary(cabinetId, from, to),
      repo.getDailySummary(cabinetId, from, to),
      repo.getCampaigns(cabinetId),
    ]);
    return c.json({ summary, dailyStats, campaigns, period: { from, to } });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/wb/balance', async (c) => {
  try {
    const wbClient = getWBClientFromContext(c);
    const balance = await wbClient.getBalance();
    return c.json(balance);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
