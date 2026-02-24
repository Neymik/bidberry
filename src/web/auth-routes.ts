import { Hono } from 'hono';
import * as authService from '../services/auth-service';
import { authMiddleware } from './auth-middleware';

const app = new Hono();

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

export default app;
