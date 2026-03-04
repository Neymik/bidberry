import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { adminMiddleware } from './auth-middleware';
import * as cabinetsRepo from '../db/cabinets-repository';

const app = new Hono();

// All admin routes require admin role
app.use('/api/admin/*', adminMiddleware);

// === USERS ===

app.get('/api/admin/users', async (c) => {
  try {
    const users = await cabinetsRepo.getAllUsers();
    return c.json(users);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === ACCOUNTS ===

app.get('/api/admin/accounts', async (c) => {
  try {
    const accounts = await cabinetsRepo.getAllAccountsWithCabinets();
    return c.json(accounts);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/admin/accounts', zValidator('json', z.object({
  name: z.string().min(1),
})), async (c) => {
  const { name } = c.req.valid('json');
  try {
    const id = await cabinetsRepo.createAccount(name);
    return c.json({ id, name }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/admin/accounts/:id/users', zValidator('json', z.object({
  userId: z.number(),
  role: z.string().optional(),
})), async (c) => {
  const accountId = parseInt(c.req.param('id'));
  const { userId, role } = c.req.valid('json');
  try {
    await cabinetsRepo.addUserToAccount(userId, accountId, role || 'member');
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/api/admin/accounts/:accountId/users/:userId', async (c) => {
  const accountId = parseInt(c.req.param('accountId'));
  const userId = parseInt(c.req.param('userId'));
  try {
    await cabinetsRepo.removeUserFromAccount(userId, accountId);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === CABINETS ===

app.post('/api/admin/cabinets', zValidator('json', z.object({
  accountId: z.number(),
  name: z.string().min(1),
  wbApiKey: z.string().min(1),
})), async (c) => {
  const { accountId, name, wbApiKey } = c.req.valid('json');
  try {
    const id = await cabinetsRepo.createCabinet(accountId, name, wbApiKey);
    return c.json({ id, accountId, name }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.put('/api/admin/cabinets/:id', zValidator('json', z.object({
  name: z.string().optional(),
  wbApiKey: z.string().optional(),
  isActive: z.boolean().optional(),
})), async (c) => {
  const id = parseInt(c.req.param('id'));
  const { name, wbApiKey, isActive } = c.req.valid('json');
  try {
    await cabinetsRepo.updateCabinet(id, {
      name,
      wb_api_key: wbApiKey,
      is_active: isActive,
    });
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/api/admin/cabinets/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    await cabinetsRepo.deleteCabinet(id);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// === WHITELIST ===

app.get('/api/admin/whitelist', async (c) => {
  try {
    const users = await cabinetsRepo.getAllowedUsers();
    return c.json(users);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/admin/whitelist', zValidator('json', z.object({
  username: z.string().min(1),
})), async (c) => {
  const { username } = c.req.valid('json');
  const adminUser = c.get('telegramId' as never) as string;
  try {
    await cabinetsRepo.addAllowedUser(username, adminUser);
    return c.json({ success: true }, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.delete('/api/admin/whitelist/:username', async (c) => {
  const username = decodeURIComponent(c.req.param('username'));
  try {
    await cabinetsRepo.removeAllowedUser(username);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
