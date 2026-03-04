import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as ordersService from '../services/orders-service';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';

const app = new Hono();

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  nmId: z.string().optional(),
});

// Sync orders from WB
app.post('/api/sync/orders', async (c) => {
  const cabinetId = getCabinetId(c);
  const wbClient = getWBClientFromContext(c);
  try {
    const body = await c.req.json().catch(() => ({})) as { dateFrom?: string };
    const count = await ordersService.syncOrders(cabinetId, wbClient, body.dateFrom);
    return c.json({ success: true, synced: count });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get orders list
app.get('/api/orders', zValidator('query', dateRangeSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo, nmId } = c.req.valid('query');
  try {
    const orders = await ordersService.getOrders(
      cabinetId,
      dateFrom,
      dateTo,
      nmId ? parseInt(nmId) : undefined
    );
    return c.json(orders);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get order statistics
app.get('/api/orders/stats', zValidator('query', dateRangeSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo, nmId } = c.req.valid('query');
  try {
    const stats = await ordersService.getOrderStats(
      cabinetId,
      dateFrom,
      dateTo,
      nmId ? parseInt(nmId) : undefined
    );
    return c.json(stats);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
