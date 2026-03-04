import { test, expect, describe, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ============================================================
// MOCK SETUP
// ============================================================

const mockGetAllUsers = mock(async () => [
  { id: 1, username: 'user1', first_name: 'User', role: 'admin', account_ids: '1' },
]);
const mockGetAllAccountsWithCabinets = mock(async () => [
  { id: 1, name: 'Account 1', cabinets: [], users: [] },
]);
const mockCreateAccount = mock(async (_name: string) => 1);
const mockAddUserToAccount = mock(async () => {});
const mockRemoveUserFromAccount = mock(async () => {});
const mockCreateCabinet = mock(async () => 10);
const mockUpdateCabinet = mock(async () => {});
const mockDeleteCabinet = mock(async () => {});
const mockGetAllowedUsers = mock(async () => [
  { id: 1, username: 'allowed1', added_by: 'admin', created_at: new Date() },
]);
const mockAddAllowedUser = mock(async () => {});
const mockRemoveAllowedUser = mock(async () => {});

mock.module('../db/cabinets-repository', () => ({
  getAllUsers: mockGetAllUsers,
  getAllAccountsWithCabinets: mockGetAllAccountsWithCabinets,
  createAccount: mockCreateAccount,
  addUserToAccount: mockAddUserToAccount,
  removeUserFromAccount: mockRemoveUserFromAccount,
  createCabinet: mockCreateCabinet,
  updateCabinet: mockUpdateCabinet,
  deleteCabinet: mockDeleteCabinet,
  getAllowedUsers: mockGetAllowedUsers,
  addAllowedUser: mockAddAllowedUser,
  removeAllowedUser: mockRemoveAllowedUser,
  // Other exports the module might need
  getCabinetsForUser: mock(async () => []),
  getCabinetById: mock(async () => null),
  getActiveCabinets: mock(async () => []),
  isUserAllowed: mock(async () => true),
  userHasAccessToCabinet: mock(async () => true),
  updateCabinetLastSync: mock(async () => {}),
}));

import adminRoutes from './admin-routes';

// ============================================================
// HELPERS
// ============================================================

function createAdminApp() {
  const app = new Hono();
  // Simulate authenticated admin
  app.use('*', async (c, next) => {
    c.set('userId', 1);
    c.set('telegramId', '12345');
    c.set('role', 'admin');
    await next();
  });
  app.route('/', adminRoutes);
  return app;
}

function createNonAdminApp() {
  const app = new Hono();
  // Simulate authenticated non-admin
  app.use('*', async (c, next) => {
    c.set('userId', 2);
    c.set('telegramId', '99999');
    c.set('role', 'user');
    await next();
  });
  app.route('/', adminRoutes);
  return app;
}

function jsonReq(method: string, path: string, body?: any) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ============================================================
// TESTS
// ============================================================

describe('Admin middleware guard', () => {
  test('blocks non-admin users (403)', async () => {
    const app = createNonAdminApp();
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toContain('admin access required');
  });
});

describe('GET /api/admin/users', () => {
  test('returns user list', async () => {
    const app = createAdminApp();
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].username).toBe('user1');
  });
});

describe('GET /api/admin/accounts', () => {
  test('returns accounts with cabinets', async () => {
    const app = createAdminApp();
    const res = await app.request('/api/admin/accounts');
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Account 1');
  });
});

describe('POST /api/admin/accounts', () => {
  beforeEach(() => {
    mockCreateAccount.mockReset();
    mockCreateAccount.mockImplementation(async () => 1);
  });

  test('creates account (201)', async () => {
    const app = createAdminApp();
    const res = await app.request(jsonReq('POST', '/api/admin/accounts', { name: 'New Account' }));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBe(1);
    expect(body.name).toBe('New Account');
    expect(mockCreateAccount).toHaveBeenCalledWith('New Account');
  });

  test('rejects empty name (400)', async () => {
    const app = createAdminApp();
    const res = await app.request(jsonReq('POST', '/api/admin/accounts', { name: '' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/accounts/:id/users', () => {
  test('adds user to account', async () => {
    mockAddUserToAccount.mockReset();
    const app = createAdminApp();
    const res = await app.request(jsonReq('POST', '/api/admin/accounts/1/users', { userId: 5 }));
    expect(res.status).toBe(200);
    expect(mockAddUserToAccount).toHaveBeenCalledWith(5, 1, 'member');
  });
});

describe('DELETE /api/admin/accounts/:accountId/users/:userId', () => {
  test('removes user from account', async () => {
    mockRemoveUserFromAccount.mockReset();
    const app = createAdminApp();
    const res = await app.request(new Request('http://localhost/api/admin/accounts/1/users/5', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockRemoveUserFromAccount).toHaveBeenCalledWith(5, 1);
  });
});

describe('POST /api/admin/cabinets', () => {
  beforeEach(() => {
    mockCreateCabinet.mockReset();
    mockCreateCabinet.mockImplementation(async () => 10);
  });

  test('creates cabinet (201)', async () => {
    const app = createAdminApp();
    const res = await app.request(jsonReq('POST', '/api/admin/cabinets', {
      accountId: 1,
      name: 'New Cabinet',
      wbApiKey: 'api-key-123',
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBe(10);
    expect(body.name).toBe('New Cabinet');
    expect(mockCreateCabinet).toHaveBeenCalledWith(1, 'New Cabinet', 'api-key-123');
  });

  test('rejects missing fields (400)', async () => {
    const app = createAdminApp();
    const res = await app.request(jsonReq('POST', '/api/admin/cabinets', { accountId: 1 }));
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/admin/cabinets/:id', () => {
  test('updates cabinet', async () => {
    mockUpdateCabinet.mockReset();
    const app = createAdminApp();
    const res = await app.request(jsonReq('PUT', '/api/admin/cabinets/10', {
      name: 'Updated Name',
      isActive: false,
    }));
    expect(res.status).toBe(200);
    expect(mockUpdateCabinet).toHaveBeenCalledWith(10, {
      name: 'Updated Name',
      wb_api_key: undefined,
      is_active: false,
    });
  });
});

describe('DELETE /api/admin/cabinets/:id', () => {
  test('deletes cabinet', async () => {
    mockDeleteCabinet.mockReset();
    const app = createAdminApp();
    const res = await app.request(new Request('http://localhost/api/admin/cabinets/10', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockDeleteCabinet).toHaveBeenCalledWith(10);
  });
});

describe('Whitelist endpoints', () => {
  test('GET /api/admin/whitelist — lists allowed users', async () => {
    const app = createAdminApp();
    const res = await app.request('/api/admin/whitelist');
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].username).toBe('allowed1');
  });

  test('POST /api/admin/whitelist — adds user (201)', async () => {
    mockAddAllowedUser.mockReset();
    const app = createAdminApp();
    const res = await app.request(jsonReq('POST', '/api/admin/whitelist', { username: 'newuser' }));
    expect(res.status).toBe(201);
    expect(mockAddAllowedUser).toHaveBeenCalledWith('newuser', '12345');
  });

  test('DELETE /api/admin/whitelist/:username — removes user', async () => {
    mockRemoveAllowedUser.mockReset();
    const app = createAdminApp();
    const res = await app.request(new Request('http://localhost/api/admin/whitelist/olduser', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(mockRemoveAllowedUser).toHaveBeenCalledWith('olduser');
  });
});
