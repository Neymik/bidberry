import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as repo from '../db/repository';

const app = new Hono();

const dateRangeSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

app.get('/api/products', async (c) => {
  try {
    const products = await repo.getProducts();
    return c.json(products);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/products/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const product = await repo.getProductById(id);
    if (!product) return c.json({ error: 'Product not found' }, 404);
    return c.json(product);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/products/:id/analytics', zValidator('query', dateRangeSchema), async (c) => {
  const id = parseInt(c.req.param('id'));
  const { dateFrom, dateTo } = c.req.valid('query');
  try {
    const analytics = await repo.getProductAnalytics(id, dateFrom, dateTo);
    return c.json(analytics);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
