import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import dayjs from 'dayjs';
import { getWBClient } from '../api/wb-client';
import * as repo from '../db/repository';
import * as exporter from '../excel/exporter';
import * as importer from '../excel/importer';
import { checkConnection } from '../db/connection';

const app = new Hono();

// Middleware
app.use('/*', cors());

// Static files
app.use('/static/*', serveStatic({ root: './public' }));

// === HEALTH CHECK ===

app.get('/api/health', async (c) => {
  const dbConnected = await checkConnection();
  const wbClient = getWBClient();
  const wbConnected = await wbClient.checkConnection();

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      database: dbConnected ? 'connected' : 'disconnected',
      wildberries: wbConnected ? 'connected' : 'disconnected',
    },
  });
});

// === DASHBOARD ===

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

app.get('/api/dashboard', zValidator('query', dateRangeSchema), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('query');
  const from = dateFrom || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const to = dateTo || dayjs().format('YYYY-MM-DD');

  try {
    const [summary, dailyStats, campaigns] = await Promise.all([
      repo.getAnalyticsSummary(from, to),
      repo.getDailySummary(from, to),
      repo.getCampaigns(),
    ]);

    return c.json({
      summary,
      dailyStats,
      campaigns,
      period: { from, to },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === CAMPAIGNS ===

app.get('/api/campaigns', async (c) => {
  try {
    const campaigns = await repo.getCampaigns();
    return c.json(campaigns);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/campaigns/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const campaign = await repo.getCampaignById(id);
    if (!campaign) {
      return c.json({ error: 'Campaign not found' }, 404);
    }
    return c.json(campaign);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/campaigns/:id/stats', zValidator('query', dateRangeSchema), async (c) => {
  const id = parseInt(c.req.param('id'));
  const { dateFrom, dateTo } = c.req.valid('query');

  try {
    const stats = await repo.getCampaignStats(id, dateFrom, dateTo);
    return c.json(stats);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/campaigns/:id/bids', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const bids = await repo.getBids(id);
    return c.json(bids);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === PRODUCTS ===

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
    if (!product) {
      return c.json({ error: 'Product not found' }, 404);
    }
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

// === SYNC FROM WB API ===

app.post('/api/sync/campaigns', async (c) => {
  try {
    const wbClient = getWBClient();
    const campaigns = await wbClient.getCampaigns();
    const count = await repo.upsertCampaigns(campaigns);
    return c.json({ success: true, synced: count });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/sync/stats', zValidator('json', z.object({
  dateFrom: z.string(),
  dateTo: z.string(),
})), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('json');

  try {
    const wbClient = getWBClient();
    const campaigns = await repo.getCampaigns();
    const campaignIds = campaigns.map(c => c.campaign_id);

    if (campaignIds.length === 0) {
      return c.json({ success: true, synced: 0, message: 'No campaigns to sync' });
    }

    const stats = await wbClient.getCampaignStats(campaignIds, dateFrom, dateTo);
    const count = await repo.upsertCampaignStatsBatch(stats);

    return c.json({ success: true, synced: count });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/sync/bids/:campaignId', async (c) => {
  const campaignId = parseInt(c.req.param('campaignId'));

  try {
    const wbClient = getWBClient();
    const bids = await wbClient.getBids(campaignId);
    const count = await repo.saveBids(campaignId, bids);
    return c.json({ success: true, synced: count });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === EXPORT ===

app.get('/api/export/campaigns', zValidator('query', dateRangeSchema), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('query');

  try {
    const campaigns = await repo.getCampaigns();
    const statsMap = new Map();

    for (const campaign of campaigns) {
      const stats = await repo.getCampaignStats(campaign.campaign_id, dateFrom, dateTo);
      statsMap.set(campaign.campaign_id, stats);
    }

    const filePath = await exporter.exportCampaignsToExcel(campaigns, statsMap);
    const file = Bun.file(filePath);

    return new Response(file, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filePath.split('/').pop()}"`,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/export/daily-stats', zValidator('query', dateRangeSchema), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('query');

  try {
    const stats = await repo.getDailySummary(dateFrom, dateTo);
    const filePath = await exporter.exportDailyStatsToExcel(stats);
    const file = Bun.file(filePath);

    return new Response(file, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filePath.split('/').pop()}"`,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/export/products', zValidator('query', dateRangeSchema), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('query');

  try {
    const products = await repo.getProducts();
    const analyticsMap = new Map();

    for (const product of products) {
      const analytics = await repo.getProductAnalytics(product.nm_id, dateFrom, dateTo);
      analyticsMap.set(product.nm_id, analytics);
    }

    const filePath = await exporter.exportProductsToExcel(products, analyticsMap);
    const file = Bun.file(filePath);

    return new Response(file, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filePath.split('/').pop()}"`,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/export/bids/:campaignId', async (c) => {
  const campaignId = parseInt(c.req.param('campaignId'));

  try {
    const bids = await repo.getBids(campaignId);
    const filePath = await exporter.exportBidsToExcel(campaignId, bids);
    const file = Bun.file(filePath);

    return new Response(file, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filePath.split('/').pop()}"`,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/export/full-report', zValidator('query', dateRangeSchema), async (c) => {
  const { dateFrom, dateTo } = c.req.valid('query');
  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to = dateTo || dayjs().format('YYYY-MM-DD');

  try {
    const [campaigns, dailySummary, products] = await Promise.all([
      repo.getCampaigns(),
      repo.getDailySummary(from, to),
      repo.getProducts(),
    ]);

    const campaignStatsMap = new Map();
    for (const campaign of campaigns) {
      const stats = await repo.getCampaignStats(campaign.campaign_id, from, to);
      campaignStatsMap.set(campaign.campaign_id, stats);
    }

    const productAnalyticsMap = new Map();
    for (const product of products) {
      const analytics = await repo.getProductAnalytics(product.nm_id, from, to);
      productAnalyticsMap.set(product.nm_id, analytics);
    }

    const filePath = await exporter.exportFullReport(
      campaigns,
      campaignStatsMap,
      dailySummary,
      products,
      productAnalyticsMap
    );

    const file = Bun.file(filePath);

    return new Response(file, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filePath.split('/').pop()}"`,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === IMPORT ===

app.post('/api/import/campaigns', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const buffer = await file.arrayBuffer();
    const tempPath = `/tmp/${Date.now()}_${file.name}`;
    await Bun.write(tempPath, buffer);

    const result = await importer.importCampaignsFromExcel(tempPath);
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/import/products', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const buffer = await file.arrayBuffer();
    const tempPath = `/tmp/${Date.now()}_${file.name}`;
    await Bun.write(tempPath, buffer);

    const result = await importer.importProductsFromExcel(tempPath);
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === TEMPLATES ===

app.get('/api/templates/campaigns', (c) => {
  const buffer = importer.generateCampaignTemplate();
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="campaigns_template.xlsx"',
    },
  });
});

app.get('/api/templates/products', (c) => {
  const buffer = importer.generateProductTemplate();
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="products_template.xlsx"',
    },
  });
});

app.get('/api/templates/bids', (c) => {
  const buffer = importer.generateBidsTemplate();
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="bids_template.xlsx"',
    },
  });
});

// === IMPORT HISTORY ===

app.get('/api/import-history', async (c) => {
  try {
    const history = await repo.getImportHistory();
    return c.json(history);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === WB BALANCE ===

app.get('/api/wb/balance', async (c) => {
  try {
    const wbClient = getWBClient();
    const balance = await wbClient.getBalance();
    return c.json(balance);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
