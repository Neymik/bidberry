import { Hono } from 'hono';
import dayjs from 'dayjs';
import { getCabinetId } from './cabinet-context';
import * as penaltyRepo from '../db/penalty-repository';

const app = new Hono();

/**
 * GET /api/penalties — warehouse penalties & dimension re-measures for the
 * current cabinet over [dateFrom, dateTo] (defaults: last 30 days). Returns a
 * by-kind summary plus per-(product × reason) groups. Data is populated by the
 * `penalty-guard` scheduled task from WB's weekly financial detail report.
 */
app.get('/api/penalties', async (c) => {
  try {
    const cabinetId = getCabinetId(c);
    const dateFrom = c.req.query('dateFrom') || dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const dateTo = c.req.query('dateTo') || dayjs().format('YYYY-MM-DD');

    const [summary, groups] = await Promise.all([
      penaltyRepo.getPenaltySummary(cabinetId, dateFrom, dateTo),
      penaltyRepo.getPenaltyGroups(cabinetId, dateFrom, dateTo),
    ]);

    return c.json({ summary, groups, dateFrom, dateTo });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
