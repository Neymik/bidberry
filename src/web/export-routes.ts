import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import dayjs from 'dayjs';
import * as repo from '../db/repository';
import * as exporter from '../excel/exporter';
import * as financialService from '../services/financial-service';
import * as reportGenerator from '../excel/report-generator';
import { getCabinetId } from './cabinet-context';

const app = new Hono();

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

app.get('/api/export/campaigns', zValidator('query', dateRangeSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const campaigns = await repo.getCampaigns(cabinetId);
    const statsMap = new Map();
    for (const campaign of campaigns) {
      const stats = await repo.getCampaignStats(cabinetId, campaign.campaign_id, dateFrom, dateTo);
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
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const stats = await repo.getDailySummary(cabinetId, dateFrom, dateTo);
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
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const products = await repo.getProducts(cabinetId);
    const analyticsMap = new Map();
    for (const product of products) {
      const analytics = await repo.getProductAnalytics(cabinetId, product.nm_id, dateFrom, dateTo);
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
  const cabinetId = getCabinetId(c);
  const campaignId = parseInt(c.req.param('campaignId'));
  try {
    const bids = await repo.getBids(cabinetId, campaignId);
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
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo } = c.req.valid('query');
  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to = dateTo || dayjs().format('YYYY-MM-DD');
  try {
    const [campaigns, dailySummary, products] = await Promise.all([
      repo.getCampaigns(cabinetId),
      repo.getDailySummary(cabinetId, from, to),
      repo.getProducts(cabinetId),
    ]);
    const campaignStatsMap = new Map();
    for (const campaign of campaigns) {
      const stats = await repo.getCampaignStats(cabinetId, campaign.campaign_id, from, to);
      campaignStatsMap.set(campaign.campaign_id, stats);
    }
    const productAnalyticsMap = new Map();
    for (const product of products) {
      const analytics = await repo.getProductAnalytics(cabinetId, product.nm_id, from, to);
      productAnalyticsMap.set(product.nm_id, analytics);
    }
    const filePath = await exporter.exportFullReport(campaigns, campaignStatsMap, dailySummary, products, productAnalyticsMap);
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

// Per-section perechen report
app.get('/api/export/perechen/:section', zValidator('query', dateRangeSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const section = c.req.param('section');
  const validSections = ['voronka', 'orders', 'stocks', 'traffic', 'marketing', 'campaigns', 'clusters'];
  if (!validSections.includes(section)) {
    return c.json({ error: `Invalid section: ${section}. Valid: ${validSections.join(', ')}` }, 400);
  }
  const { dateFrom, dateTo } = c.req.valid('query');
  const nmIdParam = c.req.query('nmId');
  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to = dateTo || dayjs().format('YYYY-MM-DD');
  try {
    const nmId = nmIdParam ? parseInt(nmIdParam) : undefined;
    const filePath = await reportGenerator.generateSectionReport(
      cabinetId,
      section as any,
      from,
      to,
      nmId
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

// Перечень информации (полный отчёт по шаблону)
app.get('/api/export/perechen', zValidator('query', dateRangeSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo } = c.req.valid('query');
  const nmIdParam = c.req.query('nmId');
  const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const to = dateTo || dayjs().format('YYYY-MM-DD');
  try {
    const nmId = nmIdParam ? parseInt(nmIdParam) : undefined;
    const filePath = await reportGenerator.generatePerechenReport(cabinetId, from, to, nmId);
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

app.get('/api/export/pnl', zValidator('query', dateRangeSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const pnl = await financialService.getPnL(cabinetId, dateFrom, dateTo);
    return c.json(pnl);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
