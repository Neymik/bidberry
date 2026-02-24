import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as smartBidder from '../services/smart-bidder';
import * as scheduler from '../services/scheduler';

const app = new Hono();

const bidRuleSchema = z.object({
  campaign_id: z.number(),
  keyword: z.string().optional(),
  strategy: z.enum(['target_position', 'target_cpc', 'max_bid', 'drr_target']),
  target_value: z.number(),
  min_bid: z.number().optional(),
  max_bid: z.number().optional(),
  step: z.number().optional(),
});

app.get('/api/campaigns/:id/bid-rules', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const rules = await smartBidder.getRules(id);
    return c.json(rules);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/campaigns/:id/bid-rules', zValidator('json', bidRuleSchema.omit({ campaign_id: true })), async (c) => {
  const campaignId = parseInt(c.req.param('id'));
  const input = c.req.valid('json');
  try {
    const ruleId = await smartBidder.createRule({ ...input, campaign_id: campaignId });
    return c.json({ success: true, ruleId });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.put('/api/bid-rules/:ruleId', zValidator('json', z.object({
  strategy: z.enum(['target_position', 'target_cpc', 'max_bid', 'drr_target']).optional(),
  target_value: z.number().optional(),
  min_bid: z.number().optional(),
  max_bid: z.number().optional(),
  step: z.number().optional(),
  is_active: z.boolean().optional(),
  keyword: z.string().optional(),
})), async (c) => {
  const ruleId = parseInt(c.req.param('ruleId'));
  const updates = c.req.valid('json');
  try {
    await smartBidder.updateRule(ruleId, updates);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/api/bid-rules/:ruleId', async (c) => {
  const ruleId = parseInt(c.req.param('ruleId'));
  try {
    await smartBidder.deleteRule(ruleId);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/campaigns/:id/bid-history', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const history = await smartBidder.getBidHistory(id);
    return c.json(history);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/campaigns/:id/adjust-bids', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const result = await smartBidder.adjustBidsForCampaign(id);
    return c.json({ success: true, ...result });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/smart-bidder/run', async (c) => {
  try {
    const result = await smartBidder.runAllRules();
    return c.json({ success: true, ...result });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/smart-bidder/status', (c) => {
  return c.json(scheduler.getStatus());
});

export default app;
