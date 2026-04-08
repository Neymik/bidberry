import { test, expect, describe, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

const mockSendCabinetReport = mock(async (id: number) => true);
const mockGenerateCabinetReport = mock(async (id: number) => 'fake report');

mock.module('../services/cabinet-report', () => ({
  sendCabinetReport: mockSendCabinetReport,
  generateCabinetReport: mockGenerateCabinetReport,
}));

describe('trigger-routes auth', () => {
  beforeEach(() => {
    mockSendCabinetReport.mockClear();
    mockGenerateCabinetReport.mockClear();
    process.env.TRIGGER_SECRET = 'test-secret-1234567890abcdef1234567890ab';
  });

  async function freshApp() {
    const mod = await import('./trigger-routes?bust=' + Date.now());
    const app = new Hono();
    app.route('/', mod.default);
    return app;
  }

  test('POST without X-Trigger-Secret returns 401', async () => {
    const app = await freshApp();
    const res = await app.request('/api/trigger/cabinet-report/5', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(mockSendCabinetReport).not.toHaveBeenCalled();
  });

  test('POST with wrong X-Trigger-Secret returns 401', async () => {
    const app = await freshApp();
    const res = await app.request('/api/trigger/cabinet-report/5', {
      method: 'POST',
      headers: { 'X-Trigger-Secret': 'wrong' },
    });
    expect(res.status).toBe(401);
  });

  test('POST with correct X-Trigger-Secret returns 202', async () => {
    const app = await freshApp();
    const res = await app.request('/api/trigger/cabinet-report/5', {
      method: 'POST',
      headers: { 'X-Trigger-Secret': process.env.TRIGGER_SECRET! },
    });
    expect(res.status).toBe(202);
    expect(mockSendCabinetReport).toHaveBeenCalledWith(5);
  });

  test('GET without secret returns 401', async () => {
    const app = await freshApp();
    const res = await app.request('/api/trigger/cabinet-report/5');
    expect(res.status).toBe(401);
    expect(mockGenerateCabinetReport).not.toHaveBeenCalled();
  });

  test('GET with secret returns text', async () => {
    const app = await freshApp();
    const res = await app.request('/api/trigger/cabinet-report/5', {
      headers: { 'X-Trigger-Secret': process.env.TRIGGER_SECRET! },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('fake report');
  });

  test('rejects when TRIGGER_SECRET is unset on the server', async () => {
    delete process.env.TRIGGER_SECRET;
    const app = await freshApp();
    const res = await app.request('/api/trigger/cabinet-report/5', {
      method: 'POST',
      headers: { 'X-Trigger-Secret': 'anything' },
    });
    expect(res.status).toBe(401);
  });
});
