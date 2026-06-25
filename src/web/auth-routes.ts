import { Hono } from 'hono';
import * as authService from '../services/auth-service';
import * as oidc from '../services/telegram-oidc';
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

// Public config (bot name)
app.get('/api/auth/config', (c) => {
  return c.json({
    telegram_bot_name: process.env.TELEGRAM_BOT_NAME || '',
    oidc_enabled: oidc.isConfigured(),
  });
});

// --- Telegram OpenID Connect login (Authorization Code + PKCE) ---
// Replaces the old QR/deep-link bot flow. See src/services/telegram-oidc.ts.

// The redirect_uri MUST exactly match a URL registered in @BotFather → Bot
// Settings → Web Login. Pin it via OAUTH_REDIRECT_BASE; otherwise derive it
// from the (proxied) request host.
function redirectBase(c: any): string {
  const env = process.env.OAUTH_REDIRECT_BASE;
  if (env) return env.replace(/\/$/, '');
  const proto = c.req.header('X-Forwarded-Proto') || 'https';
  const host = c.req.header('X-Forwarded-Host') || c.req.header('Host') || '';
  return `${proto}://${host}`;
}

// 1) Browser hits this; we 302 to Telegram's consent screen.
app.get('/api/auth/telegram/oidc/start', (c) => {
  if (!oidc.isConfigured()) {
    return c.json({ error: 'Telegram OIDC is not configured' }, 500);
  }
  const redirectUri = `${redirectBase(c)}/api/auth/telegram/oidc/callback`;
  return c.redirect(oidc.buildAuthUrl(redirectUri), 302);
});

// 2) Telegram redirects back here with ?code&state. We exchange server-side,
//    run the whitelist + upsert, set the session cookie, and bounce to the SPA.
//    On any failure we send the user back to the login screen with a message.
app.get('/api/auth/telegram/oidc/callback', async (c) => {
  const err = c.req.query('error');
  if (err) return c.redirect(`/?login_error=${encodeURIComponent(err)}`, 302);

  const code = c.req.query('code') || '';
  const state = c.req.query('state') || '';
  if (!code || !state) return c.redirect('/?login_error=missing_code', 302);

  try {
    const profile = await oidc.exchangeCode(code, state);
    const auth = await authService.loginWithTelegramVerified(profile);
    setSessionCookie(c, auth.access_token);
    return c.redirect('/', 302);
  } catch (error: any) {
    return c.redirect(`/?login_error=${encodeURIComponent(error.message || 'login_failed')}`, 302);
  }
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
