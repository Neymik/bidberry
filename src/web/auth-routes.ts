import { Hono } from 'hono';
import { timingSafeEqual } from 'crypto';
import QRCode from 'qrcode';
import * as authService from '../services/auth-service';
import * as tgLogin from '../services/tg-login-store';
import { authMiddleware, adminMiddleware } from './auth-middleware';
import * as emuRepo from '../db/emulator-repository';
import * as cabinetsRepo from '../db/cabinets-repository';

const app = new Hono();

const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60; // 1 day, matches JWT TTL

function setSessionCookie(c: any, accessToken: string) {
  c.header(
    'Set-Cookie',
    `access_token=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  );
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Public config (bot name for Telegram widget)
app.get('/api/auth/config', (c) => {
  return c.json({
    telegram_bot_name: process.env.TELEGRAM_BOT_NAME || '',
  });
});

// Telegram Login
app.post('/api/auth/telegram', async (c) => {
  try {
    const data = await c.req.json();
    const result = await authService.loginWithTelegram(data);

    // Set access token as httpOnly cookie
    const maxAge = 24 * 60 * 60; // 1 day
    c.header('Set-Cookie', `access_token=${result.access_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);

    return c.json(result);
  } catch (error: any) {
    const status = error.message.includes('Invalid') || error.message.includes('expired') ? 401 : 500;
    return c.json({ error: error.message }, status);
  }
});

// --- Telegram deep-link / QR login (no phone, opens the Telegram app) ---

// 1) Browser asks for a login link. We mint a one-time token and return a
//    t.me deep link + an SVG QR of it. See src/services/tg-login-store.ts.
app.post('/api/auth/telegram/deeplink', async (c) => {
  const botName = process.env.TELEGRAM_BOT_NAME || '';
  if (!botName) return c.json({ error: 'Telegram bot is not configured' }, 500);

  const token = tgLogin.createToken();
  const url = `https://t.me/${botName}?start=${token}`;
  const qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });

  return c.json({ token, bot: botName, url, qr, expires_in: tgLogin.TTL_SEC });
});

// 2) The bot calls this (localhost + X-Trigger-Secret) when a user opens the
//    deep link. We run the whitelist check and attach the issued session to
//    the token. Trust = shared secret + Telegram-authenticated update.
app.post('/api/auth/telegram/confirm', async (c) => {
  const expected = process.env.TRIGGER_SECRET || '';
  const got = c.req.header('X-Trigger-Secret') || '';
  if (!expected || expected.length < 16 || !constantTimeEq(got, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const token: string = body?.token || '';
  const tu = body?.telegram_user;
  if (!token || !tu || typeof tu.id !== 'number') {
    return c.json({ error: 'token and telegram_user.id are required' }, 400);
  }

  const entry = tgLogin.getEntry(token);
  if (!entry) return c.json({ status: 'expired' });
  if (entry.status !== 'pending') return c.json({ status: entry.status });

  try {
    const auth = await authService.loginWithTelegramVerified({
      id: tu.id,
      username: tu.username || undefined,
      first_name: tu.first_name || undefined,
      last_name: tu.last_name || undefined,
      photo_url: tu.photo_url || undefined,
    });
    tgLogin.markConfirmed(token, auth);
    return c.json({ status: 'confirmed' });
  } catch (error: any) {
    tgLogin.markDenied(token, error.message || 'Access denied');
    return c.json({ status: 'denied', error: error.message });
  }
});

// 3) Browser polls until the token flips to confirmed/denied/expired. On
//    confirm we set the session cookie and hand back the same payload shape
//    as the widget login.
app.get('/api/auth/telegram/check', (c) => {
  const token = c.req.query('token') || '';
  const entry = tgLogin.getEntry(token);
  if (!entry) return c.json({ status: 'expired' });
  if (entry.status === 'pending') return c.json({ status: 'pending' });

  if (entry.status === 'denied') {
    tgLogin.consume(token);
    return c.json({ status: 'denied', error: entry.error });
  }

  // confirmed
  const { auth } = entry;
  tgLogin.consume(token);
  setSessionCookie(c, auth.access_token);
  return c.json({
    status: 'confirmed',
    access_token: auth.access_token,
    expires_at: auth.expires_at,
    user: auth.user,
  });
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (c) => {
  try {
    const userId = c.get('userId' as never) as number;
    const user = await authService.getCurrentUser(userId);
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json(user);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Logout
app.post('/api/auth/logout', (c) => {
  c.header('Set-Cookie', 'access_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return c.json({ success: true });
});

// Internal: admin auth verification for nginx auth_request
app.get('/api/auth/check-admin', authMiddleware, adminMiddleware, (c) => {
  return c.body(null, 200);
});

// Internal: logged-in (= whitelisted) verification for nginx auth_request.
// Login already enforces the whitelist, so any valid JWT means a whitelisted
// user. Used to gate the dev task board (/admin/tasks) behind Telegram login
// for the same whitelisted users that can use the app.
app.get('/api/auth/check-user', authMiddleware, (c) => {
  return c.body(null, 200);
});

// Internal: emulator auth verification for nginx auth_request
app.get('/api/auth/check-emu', authMiddleware, async (c) => {
  const userId = c.get('userId' as never) as number;
  const originalUri = c.req.header('X-Original-URI') || '';

  // Extract instance ID from /emu/{id}/...
  const match = originalUri.match(/^\/emu\/(\d+)\//);
  if (!match) return c.body(null, 403);

  const instanceId = parseInt(match[1]);
  const instance = await emuRepo.getInstanceById(instanceId);
  if (!instance) return c.body(null, 404);

  // Check user has access to the instance's cabinet
  const hasAccess = await cabinetsRepo.userHasAccessToCabinet(userId, instance.cabinet_id);
  if (!hasAccess) return c.body(null, 403);

  return c.body(null, 200);
});

export default app;
