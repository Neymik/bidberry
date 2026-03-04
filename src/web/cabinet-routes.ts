import { Hono } from 'hono';
import * as cabinetsRepo from '../db/cabinets-repository';

const app = new Hono();

app.get('/api/cabinets', async (c) => {
  const userId = c.get('userId' as never) as number;
  try {
    const cabinets = await cabinetsRepo.getCabinetsForUser(userId);
    // Strip API keys from response
    return c.json(cabinets.map(({ wb_api_key, ...rest }) => rest));
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/cabinets/:id', async (c) => {
  const userId = c.get('userId' as never) as number;
  const id = parseInt(c.req.param('id'));
  try {
    const hasAccess = await cabinetsRepo.userHasAccessToCabinet(userId, id);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }
    const cabinet = await cabinetsRepo.getCabinetById(id);
    if (!cabinet) {
      return c.json({ error: 'Cabinet not found' }, 404);
    }
    // Strip API key from response
    const { wb_api_key, ...rest } = cabinet;
    return c.json(rest);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
