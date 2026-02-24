import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as financialService from '../services/financial-service';

const app = new Hono();

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

app.get('/api/financial/pnl', zValidator('query', dateRangeSchema), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const pnl = await financialService.getPnL(dateFrom, dateTo);
    return c.json(pnl);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/financial/pnl/:nmId', zValidator('query', dateRangeSchema), async (c) => {
  const nmId = parseInt(c.req.param('nmId'));
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const pnl = await financialService.getProductPnL(nmId, dateFrom, dateTo);
    if (!pnl) return c.json({ error: 'Product not found' }, 404);
    return c.json(pnl);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/financial/unit-economics/:nmId', async (c) => {
  const nmId = parseInt(c.req.param('nmId'));
  try {
    const ue = await financialService.getUnitEconomics(nmId);
    if (!ue) return c.json({ error: 'Product not found' }, 404);
    return c.json(ue);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/products/:nmId/costs', async (c) => {
  const nmId = parseInt(c.req.param('nmId'));
  try {
    const costs = await financialService.getProductCosts(nmId);
    return c.json(costs || { nm_id: nmId, cost_price: 0, logistics_cost: 0, commission_pct: 0, storage_cost: 0, packaging_cost: 0, additional_cost: 0 });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/products/:nmId/costs', zValidator('json', z.object({
  cost_price: z.number().optional(),
  logistics_cost: z.number().optional(),
  commission_pct: z.number().optional(),
  storage_cost: z.number().optional(),
  packaging_cost: z.number().optional(),
  additional_cost: z.number().optional(),
})), async (c) => {
  const nmId = parseInt(c.req.param('nmId'));
  const costs = c.req.valid('json');
  try {
    await financialService.updateProductCosts(nmId, costs);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/sync/sales-report', zValidator('json', z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
})), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('json');
  try {
    const count = await financialService.syncSalesReport(dateFrom, dateTo);
    return c.json({ success: true, synced: count });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
