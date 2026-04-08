/**
 * Webhook endpoints for external systems to trigger actions.
 *
 * Auth: every request MUST include `X-Trigger-Secret: ${TRIGGER_SECRET}`.
 * In addition, the app binds to 127.0.0.1 (defense in depth), but the secret
 * is the real auth boundary — host network mode in docker-compose.yml means
 * the bind address alone is not sufficient.
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'crypto';
import { generateCabinetReport, sendCabinetReport } from '../services/cabinet-report';

const app = new Hono();

function constantTimeStringEq(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. Pad to a common length
  // (the longer of the two) so we don't leak length via early return.
  const maxLen = Math.max(a.length, b.length);
  const ab = Buffer.alloc(maxLen);
  const bb = Buffer.alloc(maxLen);
  ab.write(a);
  bb.write(b);
  // Length mismatch => not equal, but still do the compare to keep timing flat.
  return timingSafeEqual(ab, bb) && a.length === b.length;
}

async function requireTriggerSecret(c: Context, next: Next) {
  const expected = process.env.TRIGGER_SECRET || '';
  if (!expected || expected.length < 16) {
    console.error('[trigger] TRIGGER_SECRET is not set or too short — rejecting all webhook calls');
    return c.json({ error: 'unauthorized' }, 401);
  }
  const got = c.req.header('X-Trigger-Secret') || '';
  if (!constantTimeStringEq(got, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
}

// All trigger routes require the shared secret.
app.use('/api/trigger/*', requireTriggerSecret);

// POST /api/trigger/cabinet-report/:cabinetId
// Triggered by WBPartners-Auto on detection of a new order.
// Fires the Telegram send in the background and returns 202 immediately.
app.post('/api/trigger/cabinet-report/:cabinetId', async (c) => {
  const cabinetId = parseInt(c.req.param('cabinetId'), 10);
  if (!cabinetId || Number.isNaN(cabinetId)) {
    return c.json({ error: 'invalid cabinetId' }, 400);
  }

  sendCabinetReport(cabinetId).catch(err => {
    console.error(`[trigger] cabinet-report ${cabinetId} failed: ${err.message}`);
  });

  return c.json({ accepted: true, cabinetId }, 202);
});

// GET /api/trigger/cabinet-report/:cabinetId
// Returns the generated report text as JSON without sending to Telegram.
// Used by the WBPartners-Auto Telegram bot to reply to /count commands.
app.get('/api/trigger/cabinet-report/:cabinetId', async (c) => {
  const cabinetId = parseInt(c.req.param('cabinetId'), 10);
  if (!cabinetId || Number.isNaN(cabinetId)) {
    return c.json({ error: 'invalid cabinetId' }, 400);
  }

  try {
    const text = await generateCabinetReport(cabinetId);
    return c.json({ cabinetId, text: text ?? '', empty: text == null });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
