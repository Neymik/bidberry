import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import * as eventsRepo from '../db/events-repository';
import { getCabinetId } from './cabinet-context';

const app = new Hono();

const createEventSchema = z.object({
  nm_id: z.number(),
  event_type: z.string(),
  description: z.string().optional(),
  event_date: z.string(),
});

const updateEventSchema = z.object({
  event_type: z.string().optional(),
  description: z.string().optional(),
  event_date: z.string().optional(),
});

// Get events for a product
app.get('/api/products/:nmId/events', async (c) => {
  const cabinetId = getCabinetId(c);
  const nmId = parseInt(c.req.param('nmId'));
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');
  try {
    const events = await eventsRepo.getEventsByNmId(
      cabinetId,
      nmId,
      dateFrom || undefined,
      dateTo || undefined
    );
    return c.json(events);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get all events
app.get('/api/events', async (c) => {
  const cabinetId = getCabinetId(c);
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');
  try {
    const events = await eventsRepo.getAllEvents(
      cabinetId,
      dateFrom || undefined,
      dateTo || undefined
    );
    return c.json(events);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Create event
app.post('/api/products/:nmId/events', zValidator('json', createEventSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  try {
    const data = c.req.valid('json');
    const userId = c.get('userId' as never) as number | undefined;
    const id = await eventsRepo.createEvent(cabinetId, {
      ...data,
      created_by: userId,
    });
    return c.json({ success: true, id }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Update event
app.put('/api/events/:id', zValidator('json', updateEventSchema), async (c) => {
  const cabinetId = getCabinetId(c);
  const id = parseInt(c.req.param('id'));
  try {
    const data = c.req.valid('json');
    await eventsRepo.updateEvent(cabinetId, id, data);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Delete event
app.delete('/api/events/:id', async (c) => {
  const cabinetId = getCabinetId(c);
  const id = parseInt(c.req.param('id'));
  try {
    await eventsRepo.deleteEvent(cabinetId, id);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
