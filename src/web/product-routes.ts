import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as repo from '../db/repository';
import * as trafficRepo from '../db/traffic-repository';
import { getWBClient } from '../api/wb-client';
import dayjs from 'dayjs';

const app = new Hono();

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

app.get('/api/products', async (c) => {
  try {
    const products = await repo.getProducts();
    return c.json(products);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/products/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const product = await repo.getProductById(id);
    if (!product) return c.json({ error: 'Product not found' }, 404);
    return c.json(product);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/products/:id/analytics', zValidator('query', dateRangeSchema), async (c) => {
  const id = parseInt(c.req.param('id'));
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const analytics = await repo.getProductAnalytics(id, dateFrom, dateTo);
    return c.json(analytics);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Sync products from WB Content API
app.post('/api/sync/products', async (c) => {
  const importId = await repo.createImportRecord('products-sync');
  try {
    const wbClient = getWBClient();
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];
    let cursor: string | undefined;

    // Paginate through all products
    while (true) {
      try {
        const result = await wbClient.getProducts(100, cursor);
        const cards = result.cards || [];
        if (cards.length === 0) break;

        for (const card of cards) {
          await repo.upsertProduct({
            nmId: card.nmID,
            vendorCode: card.vendorCode,
            brand: card.brand,
            subject: card.subjectName || card.subject,
            name: card.title || card.name,
          });
          totalSynced++;
        }

        if (!result.cursor || cards.length < 100) break;
        cursor = JSON.stringify(result.cursor);
        await Bun.sleep(500);
      } catch (err: any) {
        errors++;
        errorMessages.push(err.message);
        console.error(`[sync/products] Page error: ${err.message}`);
        break; // Can't continue pagination on error
      }
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    return c.json({ success: true, synced: totalSynced, errors, errorMessages });
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    return c.json({ error: error.message }, 500);
  }
});

// Sync product analytics from WB Analytics API
app.post('/api/sync/product-analytics', async (c) => {
  const importId = await repo.createImportRecord('product-analytics-sync');
  try {
    const body = await c.req.json().catch(() => ({})) as { dateFrom?: string; dateTo?: string };
    const dateFrom = body.dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const dateTo = body.dateTo || dayjs().format('YYYY-MM-DD');

    const products = await repo.getProducts();
    if (products.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      return c.json({ success: true, synced: 0, message: 'No products to sync analytics for' });
    }

    const wbClient = getWBClient();
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];

    // Process in batches of 20 (WB API limit)
    const batchSize = 20;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const nmIds = batch.map(p => p.nm_id);

      try {
        const analytics = await wbClient.getProductAnalytics(nmIds, dateFrom, dateTo);
        for (const item of analytics) {
          const period = item.statistics?.selectedPeriod;
          if (period) {
            await repo.upsertProductAnalytics(item, dateFrom);
            totalSynced++;
          }
        }
      } catch (err: any) {
        errors++;
        const batchNum = Math.floor(i / batchSize) + 1;
        errorMessages.push(`Batch ${batchNum}: ${err.message}`);
        console.error(`[sync/product-analytics] Batch ${batchNum} error: ${err.message}`);
      }

      if (i + batchSize < products.length) await Bun.sleep(500);
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    return c.json({ success: true, synced: totalSynced, errors, errorMessages });
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    return c.json({ error: error.message }, 500);
  }
});

// Sync traffic sources from WB Analytics API (detailed report)
app.post('/api/sync/traffic-sources', async (c) => {
  const importId = await repo.createImportRecord('traffic-sources-sync');
  try {
    const body = await c.req.json().catch(() => ({})) as { dateFrom?: string; dateTo?: string };
    const dateFrom = body.dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const dateTo = body.dateTo || dayjs().format('YYYY-MM-DD');

    const products = await repo.getProducts();
    if (products.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      return c.json({ success: true, synced: 0, message: 'No products to sync traffic sources for' });
    }

    const wbClient = getWBClient();
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];

    // Process in batches of 20
    const batchSize = 20;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const nmIds = batch.map(p => p.nm_id);

      try {
        const response = await wbClient.getProductAnalyticsDetailed(nmIds, dateFrom, dateTo);
        const products = response?.data?.products || [];

        for (const item of products) {
          const nmId = item.product?.nmId;
          const stats = item.statistic?.selected;
          if (!nmId || !stats) continue;

          await trafficRepo.upsertTrafficSource({
            nm_id: nmId,
            date: dateFrom,
            source_name: 'total',
            open_card_count: stats.openCount ?? 0,
            add_to_cart_count: stats.cartCount ?? 0,
            orders_count: stats.orderCount ?? 0,
            orders_sum: stats.orderSum ?? 0,
            buyouts_count: stats.buyoutCount ?? 0,
            buyouts_sum: stats.buyoutSum ?? 0,
            cancel_count: stats.cancelCount ?? 0,
            cancel_sum: stats.cancelSum ?? 0,
          });
          totalSynced++;
        }
      } catch (err: any) {
        errors++;
        const batchNum = Math.floor(i / batchSize) + 1;
        errorMessages.push(`Batch ${batchNum}: ${err.message}`);
        console.error(`[sync/traffic-sources] Batch ${batchNum} error: ${err.message}`);
      }

      if (i + batchSize < products.length) await Bun.sleep(500);
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    return c.json({ success: true, synced: totalSynced, errors, errorMessages });
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    return c.json({ error: error.message }, 500);
  }
});

export default app;
