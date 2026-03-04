import { test, expect, describe, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ============================================================
// MOCK SETUP
// ============================================================

const MOCK_CABINETS = [
  {
    id: 1,
    account_id: 1,
    name: 'Cabinet A',
    wb_api_key: 'secret-key-a',
    is_active: true,
    last_sync_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  },
  {
    id: 2,
    account_id: 1,
    name: 'Cabinet B',
    wb_api_key: 'secret-key-b',
    is_active: true,
    last_sync_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  },
];

const mockGetCabinetsForUser = mock(async (_userId: number) => MOCK_CABINETS);
const mockUserHasAccessToCabinet = mock(async (_userId: number, _cabinetId: number) => true);
const mockGetCabinetById = mock(async (id: number) => MOCK_CABINETS.find(c => c.id === id) || null);

mock.module('../db/cabinets-repository', () => ({
  getCabinetsForUser: mockGetCabinetsForUser,
  userHasAccessToCabinet: mockUserHasAccessToCabinet,
  getCabinetById: mockGetCabinetById,
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

import cabinetRoutes from './cabinet-routes';

// ============================================================
// HELPERS
// ============================================================

function createTestApp() {
  const app = new Hono();
  // Simulate authenticated user
  app.use('*', async (c, next) => {
    c.set('userId', 1);
    c.set('role', 'user');
    await next();
  });
  app.route('/', cabinetRoutes);
  return app;
}

// ============================================================
// TESTS
// ============================================================

describe('GET /api/cabinets', () => {
  beforeEach(() => {
    mockGetCabinetsForUser.mockReset();
    mockGetCabinetsForUser.mockImplementation(async () => MOCK_CABINETS);
  });

  test('returns cabinets without wb_api_key', async () => {
    const app = createTestApp();
    const res = await app.request('/api/cabinets');
    expect(res.status).toBe(200);

    const body = await res.json() as any[];
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe('Cabinet A');
    expect(body[0].id).toBe(1);
    // Must NOT include API key
    expect(body[0].wb_api_key).toBeUndefined();
    expect(body[1].wb_api_key).toBeUndefined();
  });

  test('returns empty array when user has no cabinets', async () => {
    mockGetCabinetsForUser.mockImplementation(async () => []);

    const app = createTestApp();
    const res = await app.request('/api/cabinets');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test('handles DB error (returns 500)', async () => {
    mockGetCabinetsForUser.mockImplementation(async () => {
      throw new Error('DB connection failed');
    });

    const app = createTestApp();
    const res = await app.request('/api/cabinets');
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toBe('DB connection failed');
  });
});

describe('GET /api/cabinets/:id', () => {
  beforeEach(() => {
    mockUserHasAccessToCabinet.mockReset();
    mockUserHasAccessToCabinet.mockImplementation(async () => true);
    mockGetCabinetById.mockReset();
    mockGetCabinetById.mockImplementation(async (id: number) => MOCK_CABINETS.find(c => c.id === id) || null);
  });

  test('returns cabinet detail without api key', async () => {
    const app = createTestApp();
    const res = await app.request('/api/cabinets/1');
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.id).toBe(1);
    expect(body.name).toBe('Cabinet A');
    expect(body.wb_api_key).toBeUndefined();
  });

  test('returns 403 when user has no access', async () => {
    mockUserHasAccessToCabinet.mockImplementation(async () => false);

    const app = createTestApp();
    const res = await app.request('/api/cabinets/1');
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toBe('Access denied');
  });

  test('returns 404 when cabinet does not exist', async () => {
    mockGetCabinetById.mockImplementation(async () => null);

    const app = createTestApp();
    const res = await app.request('/api/cabinets/999');
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toBe('Cabinet not found');
  });
});
