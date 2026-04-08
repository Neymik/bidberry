import { test, expect, describe, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ============================================================
// MOCK SETUP
// ============================================================

const mockVerifyToken = mock((token: string) => ({
  userId: 1,
  telegramId: 12345,
  role: 'user',
}));

const mockUserHasAccess = mock(async (userId: number, cabinetId: number) => true);
const mockGetCabinetById = mock(async (id: number) => ({
  id,
  account_id: 1,
  name: 'Test Cabinet',
  wb_api_key: 'test-key',
  is_active: true,
  last_sync_at: null,
  created_at: new Date(),
  updated_at: new Date(),
}));
const mockGetCabinetsForUser = mock(async (userId: number) => [
  {
    id: 1,
    account_id: 1,
    name: 'Default Cabinet',
    wb_api_key: 'default-key',
    is_active: true,
    last_sync_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  },
]);

mock.module('../services/auth-service', () => ({
  verifyToken: mockVerifyToken,
  verifyTelegramAuth: mock(() => true),
  generateToken: mock(() => 'mock-token'),
  login: mock(async () => ({})),
}));

mock.module('../db/cabinets-repository', () => ({
  userHasAccessToCabinet: mockUserHasAccess,
  getCabinetById: mockGetCabinetById,
  getCabinetsForUser: mockGetCabinetsForUser,
  getActiveCabinets: mock(async () => []),
  isUserAllowed: mock(async () => true),
  addAllowedUser: mock(async () => {}),
  removeAllowedUser: mock(async () => {}),
  getAllowedUsers: mock(async () => []),
  getAllUsers: mock(async () => []),
  getAllAccountsWithCabinets: mock(async () => []),
  createAccount: mock(async () => 1),
  createCabinet: mock(async () => 1),
  updateCabinet: mock(async () => {}),
  deleteCabinet: mock(async () => {}),
  addUserToAccount: mock(async () => {}),
  removeUserFromAccount: mock(async () => {}),
  updateCabinetLastSync: mock(async () => {}),
}));

const mockGetRoleById = mock(async (_id: number) => 'admin');
mock.module('../db/users-repository', () => ({
  getRoleById: mockGetRoleById,
}));

import { authMiddleware, adminMiddleware } from './auth-middleware';

// ============================================================
// HELPERS
// ============================================================

function createAuthApp() {
  const app = new Hono();
  app.use('/api/*', authMiddleware);
  app.get('/api/test', (c) => {
    return c.json({
      userId: c.get('userId' as never),
      telegramId: c.get('telegramId' as never),
      role: c.get('role' as never),
      cabinetId: c.get('cabinetId' as never),
      cabinetApiKey: c.get('cabinetApiKey' as never),
    });
  });
  return app;
}

function createAdminApp() {
  const app = new Hono();
  // Simulate already-authenticated context
  app.use('/api/admin/*', async (c, next) => {
    c.set('userId', 1);
    c.set('role', c.req.header('X-Test-Role') || 'user');
    await next();
  });
  app.use('/api/admin/*', adminMiddleware);
  app.get('/api/admin/test', (c) => c.json({ ok: true }));
  return app;
}

// ============================================================
// AUTH MIDDLEWARE TESTS
// ============================================================

describe('authMiddleware', () => {
  beforeEach(() => {
    mockVerifyToken.mockReset();
    mockVerifyToken.mockImplementation(() => ({
      userId: 1,
      telegramId: 12345,
      role: 'user',
    }));
    mockUserHasAccess.mockReset();
    mockUserHasAccess.mockImplementation(async () => true);
    mockGetCabinetById.mockReset();
    mockGetCabinetById.mockImplementation(async (id: number) => ({
      id,
      account_id: 1,
      name: 'Test Cabinet',
      wb_api_key: 'test-key',
      is_active: true,
      last_sync_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }));
    mockGetCabinetsForUser.mockReset();
    mockGetCabinetsForUser.mockImplementation(async () => [
      {
        id: 1,
        account_id: 1,
        name: 'Default Cabinet',
        wb_api_key: 'default-key',
        is_active: true,
        last_sync_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  });

  test('rejects request with no token (401)', async () => {
    const app = createAuthApp();
    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  test('accepts Bearer token from Authorization header', async () => {
    const app = createAuthApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    expect(mockVerifyToken).toHaveBeenCalledWith('valid-token');
  });

  test('accepts token from cookie', async () => {
    const app = createAuthApp();
    const res = await app.request('/api/test', {
      headers: { Cookie: 'access_token=cookie-token; other=val' },
    });
    expect(res.status).toBe(200);
    expect(mockVerifyToken).toHaveBeenCalledWith('cookie-token');
  });

  test('sets userId, telegramId, role in context', async () => {
    mockVerifyToken.mockImplementation(() => ({
      userId: 7,
      telegramId: 77777,
      role: 'admin',
    }));

    const app = createAuthApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(7);
    expect(body.telegramId).toBe(77777);
    expect(body.role).toBe('admin');
  });

  test('extracts X-Cabinet-Id header and validates access', async () => {
    const app = createAuthApp();
    const res = await app.request('/api/test', {
      headers: {
        Authorization: 'Bearer tok',
        'X-Cabinet-Id': '5',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cabinetId).toBe(5);
    expect(body.cabinetApiKey).toBe('test-key');
    expect(mockUserHasAccess).toHaveBeenCalledWith(1, 5);
  });

  test('returns 403 for cabinet user has no access to', async () => {
    mockUserHasAccess.mockImplementation(async () => false);

    const app = createAuthApp();
    const res = await app.request('/api/test', {
      headers: {
        Authorization: 'Bearer tok',
        'X-Cabinet-Id': '99',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Access denied');
  });

  test('falls back to first available cabinet when no X-Cabinet-Id', async () => {
    const app = createAuthApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cabinetId).toBe(1);
    expect(body.cabinetApiKey).toBe('default-key');
    expect(mockGetCabinetsForUser).toHaveBeenCalled();
  });

  test('returns 401 for invalid/expired token', async () => {
    mockVerifyToken.mockImplementation(() => {
      throw new Error('Token expired');
    });

    const app = createAuthApp();
    const res = await app.request('/api/test', {
      headers: { Authorization: 'Bearer expired-tok' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Invalid or expired');
  });
});

// ============================================================
// ADMIN MIDDLEWARE TESTS
// ============================================================

describe('adminMiddleware', () => {
  beforeEach(() => {
    mockGetRoleById.mockReset();
    mockGetRoleById.mockImplementation(async () => 'admin');
  });

  test('allows admin role through', async () => {
    const app = createAdminApp();
    const res = await app.request('/api/admin/test', {
      headers: { 'X-Test-Role': 'admin' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('blocks non-admin role (403)', async () => {
    mockGetRoleById.mockImplementation(async () => 'user');
    const app = createAdminApp();
    const res = await app.request('/api/admin/test', {
      headers: { 'X-Test-Role': 'user' },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('admin access required');
  });

  test('blocks user whose DB role was demoted even if JWT still says admin', async () => {
    mockGetRoleById.mockImplementation(async () => 'user');
    const app = createAdminApp();
    const res = await app.request('/api/admin/test', {
      headers: { 'X-Test-Role': 'admin' }, // JWT context says admin…
    });
    expect(res.status).toBe(403); // …but DB says user, so block.
  });

  test('allows when DB confirms admin role', async () => {
    mockGetRoleById.mockImplementation(async () => 'admin');
    const app = createAdminApp();
    const res = await app.request('/api/admin/test', {
      headers: { 'X-Test-Role': 'admin' },
    });
    expect(res.status).toBe(200);
  });
});
