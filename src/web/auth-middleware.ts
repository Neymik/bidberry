import type { Context, Next } from 'hono';
import { verifyToken } from '../services/auth-service';
import * as cabinetsRepo from '../db/cabinets-repository';

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

    // Extract X-Cabinet-Id header and validate access
    const cabinetIdHeader = c.req.header('X-Cabinet-Id');
    if (cabinetIdHeader) {
      const cabinetId = parseInt(cabinetIdHeader);
      if (!isNaN(cabinetId)) {
        const hasAccess = await cabinetsRepo.userHasAccessToCabinet(payload.userId, cabinetId);
        if (!hasAccess) {
          return c.json({ error: 'Access denied to this cabinet' }, 403);
        }
        const cabinet = await cabinetsRepo.getCabinetById(cabinetId);
        if (cabinet) {
          c.set('cabinetId', cabinet.id);
          c.set('cabinetApiKey', cabinet.wb_api_key);
        }
      }
    }

    // If no cabinet specified, try to set default (first available)
    if (!c.get('cabinetId' as never)) {
      const cabinets = await cabinetsRepo.getCabinetsForUser(payload.userId);
      if (cabinets.length > 0) {
        c.set('cabinetId', cabinets[0].id);
        c.set('cabinetApiKey', cabinets[0].wb_api_key);
      }
    }

    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}

/**
 * Admin-only middleware. Must be used AFTER authMiddleware.
 * Returns 403 if user role is not 'admin'.
 */
export async function adminMiddleware(c: Context, next: Next) {
  const role = c.get('role' as never) as string | undefined;
  if (role !== 'admin') {
    return c.json({ error: 'Forbidden: admin access required' }, 403);
  }
  await next();
}
