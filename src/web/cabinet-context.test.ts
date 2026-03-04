import { test, expect, describe } from 'bun:test';
import { Hono } from 'hono';
import { getCabinetId, getWBClientFromContext } from './cabinet-context';

describe('getCabinetId', () => {
  test('returns cabinetId from context', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      c.set('cabinetId', 42);
      const id = getCabinetId(c);
      return c.json({ id });
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.id).toBe(42);
  });

  test('throws when cabinetId missing', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      try {
        getCabinetId(c);
        return c.json({ error: 'should have thrown' }, 500);
      } catch (e: any) {
        return c.json({ error: e.message }, 400);
      }
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Cabinet ID is required');
  });
});

describe('getWBClientFromContext', () => {
  test('returns WB client for cabinet', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      c.set('cabinetId', 5);
      c.set('cabinetApiKey', 'test-key-5');
      const client = getWBClientFromContext(c);
      return c.json({ ok: !!client });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('throws when cabinetId missing', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      try {
        getWBClientFromContext(c);
        return c.json({ error: 'should have thrown' }, 500);
      } catch (e: any) {
        return c.json({ error: e.message }, 400);
      }
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Cabinet ID is required');
  });

  test('throws when apiKey missing', async () => {
    const app = new Hono();
    app.get('/test', (c) => {
      c.set('cabinetId', 5);
      // No cabinetApiKey set
      try {
        getWBClientFromContext(c);
        return c.json({ error: 'should have thrown' }, 500);
      } catch (e: any) {
        return c.json({ error: e.message }, 400);
      }
    });

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Cabinet API key not available');
  });
});
