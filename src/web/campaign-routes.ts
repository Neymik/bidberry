import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as repo from '../db/repository';
import { getWBClient } from '../api/wb-client';

const app = new Hono();

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

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
    if (!campaign) return c.json({ error: 'Campaign not found' }, 404);
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

export default app;
