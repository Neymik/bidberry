import { Hono } from 'hono';
import * as stockService from '../services/stock-service';

const app = new Hono();

// Sync stocks from WB
app.post('/api/sync/stocks', async (c) => {
  try {
    const count = await stockService.syncStocks();
    return c.json({ success: true, synced: count });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get stocks summary (all products)
app.get('/api/stocks', async (c) => {
  try {
    const snapshotDate = c.req.query('snapshotDate');
    const summary = await stockService.getStocksSummary(snapshotDate || undefined);
    const latestDate = await stockService.getLatestSnapshotDate();
    return c.json({ snapshot_date: latestDate, data: summary });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get stocks for specific product
app.get('/api/stocks/:nmId', async (c) => {
  const nmId = parseInt(c.req.param('nmId'));
  try {
    const snapshotDate = c.req.query('snapshotDate');
    const stocks = await stockService.getStocksByNmId(nmId, snapshotDate || undefined);
    return c.json(stocks);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
