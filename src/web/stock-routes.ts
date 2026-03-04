import { Hono } from 'hono';
import * as stockService from '../services/stock-service';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';

const app = new Hono();

// Sync stocks from WB
app.post('/api/sync/stocks', async (c) => {
  const cabinetId = getCabinetId(c);
  const wbClient = getWBClientFromContext(c);
  try {
    const count = await stockService.syncStocks(cabinetId, wbClient);
    return c.json({ success: true, synced: count });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get stocks summary (all products)
app.get('/api/stocks', async (c) => {
  const cabinetId = getCabinetId(c);
  try {
    const snapshotDate = c.req.query('snapshotDate');
    const summary = await stockService.getStocksSummary(cabinetId, snapshotDate || undefined);
    const latestDate = await stockService.getLatestSnapshotDate(cabinetId);
    return c.json({ snapshot_date: latestDate, data: summary });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get stocks for specific product
app.get('/api/stocks/:nmId', async (c) => {
  const cabinetId = getCabinetId(c);
  const nmId = parseInt(c.req.param('nmId'));
  try {
    const snapshotDate = c.req.query('snapshotDate');
    const stocks = await stockService.getStocksByNmId(cabinetId, nmId, snapshotDate || undefined);
    return c.json(stocks);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
