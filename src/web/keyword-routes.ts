import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as keywordTracker from '../services/keyword-tracker';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';

const app = new Hono();

app.get('/api/products/:nmId/keywords', async (c) => {
  const cabinetId = getCabinetId(c);
  const nmId = parseInt(c.req.param('nmId'));
  try {
    const keywords = await keywordTracker.getKeywordsForProduct(cabinetId, nmId);
    return c.json(keywords);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/products/:nmId/keywords', zValidator('json', z.object({
  keyword: z.string().min(1),
})), async (c) => {
  const cabinetId = getCabinetId(c);
  const wbClient = getWBClientFromContext(c);
  const nmId = parseInt(c.req.param('nmId'));
  const { keyword } = c.req.valid('json');
  try {
    await keywordTracker.addKeyword(cabinetId, wbClient, nmId, keyword);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/api/products/:nmId/keywords/:keyword', async (c) => {
  const cabinetId = getCabinetId(c);
  const nmId = parseInt(c.req.param('nmId'));
  const keyword = decodeURIComponent(c.req.param('keyword'));
  try {
    await keywordTracker.removeKeyword(cabinetId, nmId, keyword);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/products/:nmId/keywords/:keyword/positions', async (c) => {
  const cabinetId = getCabinetId(c);
  const nmId = parseInt(c.req.param('nmId'));
  const keyword = decodeURIComponent(c.req.param('keyword'));
  try {
    const positions = await keywordTracker.getPositionHistory(cabinetId, nmId, keyword);
    return c.json(positions);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/products/:nmId/keywords/recommended', async (c) => {
  const wbClient = getWBClientFromContext(c);
  const nmId = parseInt(c.req.param('nmId'));
  try {
    const keywords = await keywordTracker.fetchRecommendedKeywords(wbClient, nmId);
    return c.json({ keywords });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/keywords/search', zValidator('query', z.object({
  q: z.string().min(1),
})), async (c) => {
  const cabinetId = getCabinetId(c);
  const { q } = c.req.valid('query');
  try {
    const results = await keywordTracker.searchKeywords(cabinetId, q);
    return c.json(results);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/sync/keyword-positions', async (c) => {
  const cabinetId = getCabinetId(c);
  const wbClient = getWBClientFromContext(c);
  try {
    const result = await keywordTracker.checkAllPositions(cabinetId, wbClient);
    return c.json({ success: true, ...result });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/sync/keyword-positions/:nmId', async (c) => {
  const cabinetId = getCabinetId(c);
  const wbClient = getWBClientFromContext(c);
  const nmId = parseInt(c.req.param('nmId'));
  try {
    await keywordTracker.checkPositions(cabinetId, wbClient, nmId);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
