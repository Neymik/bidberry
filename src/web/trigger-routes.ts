/**
 * Webhook endpoints for external systems to trigger actions.
 * No auth — these are meant to be called from localhost (e.g., by WBPartners-Auto).
 * App binds to 127.0.0.1:3000 so these are not externally reachable.
 */

import { Hono } from 'hono';
import { generateCabinetReport, sendCabinetReport } from '../services/cabinet-report';

const app = new Hono();

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
