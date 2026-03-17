import { Hono } from 'hono';
import * as emuRepo from '../db/emulator-repository';

const app = new Hono();

// Rate limit: in-memory map
const lastRequest = new Map<string, number>();

app.post('/ingest', async (c) => {
  // Validate X-Emulator-Key
  const apiKey = c.req.header('X-Emulator-Key');
  if (!apiKey) return c.json({ error: 'Missing X-Emulator-Key' }, 401);

  const instance = await emuRepo.getInstanceByApiKey(apiKey);
  if (!instance) return c.json({ error: 'Invalid key' }, 401);

  // Rate limit: 1 req per 5s per key
  const now = Date.now();
  const last = lastRequest.get(apiKey) ?? 0;
  if (now - last < 5000) return c.json({ error: 'Rate limited' }, 429);
  lastRequest.set(apiKey, now);

  // Validate body
  const body = await c.req.json<{ orders?: any[] }>();
  if (!body.orders || !Array.isArray(body.orders)) return c.json({ error: 'Invalid body' }, 400);
  if (body.orders.length > 100) return c.json({ error: 'Max 100 orders per batch' }, 400);

  const result = await emuRepo.insertOrders(instance.cabinet_id, body.orders);
  return c.json(result);
});

app.post('/heartbeat', async (c) => {
  const apiKey = c.req.header('X-Emulator-Key');
  if (!apiKey) return c.json({ error: 'Missing X-Emulator-Key' }, 401);

  const instance = await emuRepo.getInstanceByApiKey(apiKey);
  if (!instance) return c.json({ error: 'Invalid key' }, 401);

  await emuRepo.updateHeartbeat(instance.id);
  return c.json({ ok: true });
});

export default app;
