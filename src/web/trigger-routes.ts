/**
 * Webhook endpoints for external systems to trigger actions.
 * No auth — these are meant to be called from localhost (e.g., by WBPartners-Auto).
 * App binds to 127.0.0.1:3000 so these are not externally reachable.
 */

import { Hono } from 'hono';
import { sendCabinetReport } from '../services/cabinet-report';

const app = new Hono();

// POST /api/trigger/cabinet-report/:cabinetId
// Triggered by WBPartners-Auto on detection of a new order
app.post('/api/trigger/cabinet-report/:cabinetId', async (c) => {
  const cabinetId = parseInt(c.req.param('cabinetId'), 10);
  if (!cabinetId || Number.isNaN(cabinetId)) {
    return c.json({ error: 'invalid cabinetId' }, 400);
  }

  // Fire and respond immediately — don't block caller
  sendCabinetReport(cabinetId).catch(err => {
    console.error(`[trigger] cabinet-report ${cabinetId} failed: ${err.message}`);
  });

  return c.json({ accepted: true, cabinetId }, 202);
});

export default app;
