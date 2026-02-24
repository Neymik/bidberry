import type { Context, Next } from 'hono';
import { verifyToken } from '../services/auth-service';

export async function authMiddleware(c: Context, next: Next) {
  // Try Authorization header first
  let token = c.req.header('Authorization')?.replace('Bearer ', '');

  // Fall back to cookie
  if (!token) {
    const cookies = c.req.header('Cookie') || '';
    const match = cookies.match(/access_token=([^;]+)/);
    token = match?.[1];
  }

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const payload = verifyToken(token);
    c.set('userId', payload.userId);
    c.set('telegramId', payload.telegramId);
    c.set('role', payload.role);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}
