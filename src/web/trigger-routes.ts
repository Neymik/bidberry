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
import { getHourlyCpoSeries } from '../services/cpo-hourly';
import { getProductDailySpend } from '../services/product-daily-spend';

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

// All routes in this sub-app require the shared secret. The glob is relative
// to this sub-app (not to the parent mount point), so auth stays on even if
// the sub-app is re-mounted at a different path in the future.
app.use('/*', requireTriggerSecret);

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
//
// Optional query params (all three must be provided together) let the bot
// request an arbitrary MSK wall-clock window — /count 2026-04-21, /count hour,
// etc. all go through this same path so the response format stays identical.
//   start="YYYY-MM-DD HH:mm:ss"  (MSK, inclusive)
//   end  ="YYYY-MM-DD HH:mm:ss"  (MSK, exclusive)
//   label="...header text..."
const SQL_DT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
app.get('/api/trigger/cabinet-report/:cabinetId', async (c) => {
  const cabinetId = parseInt(c.req.param('cabinetId'), 10);
  if (!cabinetId || Number.isNaN(cabinetId)) {
    return c.json({ error: 'invalid cabinetId' }, 400);
  }

  const start = c.req.query('start');
  const end = c.req.query('end');
  const label = c.req.query('label');
  let range: { start: string; end: string; label: string } | undefined;
  if (start || end || label) {
    if (!start || !end || !label) {
      return c.json({ error: 'start, end, and label must be provided together' }, 400);
    }
    if (!SQL_DT_RE.test(start) || !SQL_DT_RE.test(end)) {
      return c.json({ error: 'start/end must be "YYYY-MM-DD HH:mm:ss"' }, 400);
    }
    if (end <= start) {
      return c.json({ error: 'end must be after start' }, 400);
    }
    range = { start, end, label };
  }

  try {
    const text = await generateCabinetReport(cabinetId, range);
    return c.json({ cabinetId, text: text ?? '', empty: text == null });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/trigger/cpo-hourly/:cabinetId?hours=12
// Hourly CPO series (orders from phone DB, spend from bidberry tables) for the
// last `hours` MSK hours. Used by the WBPartners-Auto Telegram bot's /cpo
// command to render an hourly CPO graph.
app.get('/api/trigger/cpo-hourly/:cabinetId', async (c) => {
  const cabinetId = parseInt(c.req.param('cabinetId'), 10);
  if (!cabinetId || Number.isNaN(cabinetId)) {
    return c.json({ error: 'invalid cabinetId' }, 400);
  }
  const hoursRaw = parseInt(c.req.query('hours') || '12', 10);
  const hours = Number.isNaN(hoursRaw) ? 12 : hoursRaw;
  try {
    const series = await getHourlyCpoSeries(cabinetId, hours);
    if (!series) return c.json({ error: 'cabinet not found' }, 404);
    return c.json(series);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/trigger/product-daily-spend/:cabinetId?nmIds=336624719,391662797&from=2026-06-01&to=2026-06-15
// Per-nmID per-day WB ad spend (MSK days), used by the CPO comparison sheet
// export to compute CPO for days the manager hasn't filled spend in manually.
// Response: { cabinetId, spend: { "<nmId>": { "YYYY-MM-DD": spend_rub } } }
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
app.get('/api/trigger/product-daily-spend/:cabinetId', async (c) => {
  const cabinetId = parseInt(c.req.param('cabinetId'), 10);
  if (!cabinetId || Number.isNaN(cabinetId)) {
    return c.json({ error: 'invalid cabinetId' }, 400);
  }
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to)) {
    return c.json({ error: 'from/to must be "YYYY-MM-DD"' }, 400);
  }
  if (to < from) {
    return c.json({ error: 'to must be >= from' }, 400);
  }
  const nmIds = (c.req.query('nmIds') || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n));
  if (nmIds.length === 0) {
    return c.json({ error: 'nmIds is required (comma-separated)' }, 400);
  }
  try {
    const spend = await getProductDailySpend(cabinetId, nmIds, from, to);
    return c.json({ cabinetId, spend });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
