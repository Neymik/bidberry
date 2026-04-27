# Testing Patterns

**Analysis Date:** 2026-04-27

This codebase has two test layers: **`bun test`** for the TypeScript backend (the only enforced test suite) and **no automated tests** for the Python `WBPartners-Auto/` subsystem (verification there happens via systemd logs and ad-hoc scripts).

---

## Test Framework

**Runner:** `bun:test` (the test runner built into Bun 1.3.6)
- Config: none (no `bunfig.toml`, no `jest.config.*`, no `vitest.config.*`)
- Discovery: any `*.test.ts` file under the project root that is NOT in `node_modules`
- Test file count: 9 — see "Test Inventory" below

**Assertion library:** Built-in `expect` from `bun:test` (Jest-compatible API: `toBe`, `toEqual`, `toContain`, `toBeInstanceOf`, `toHaveLength`, `toHaveBeenCalledWith`, `not.toThrow`, `rejects.toThrow`, `toBeGreaterThan`, `toEndWith`, `toBeTruthy`, `toBeUndefined`).

**Mocking:** `mock()` and `mock.module()` from `bun:test`. **DO NOT use `jest.mock` or `vi.mock`** — those don't exist.

**Run commands:**
```bash
bun test                              # Run all tests
bun test src/services/cabinet-report  # Filter by path substring
bun test --watch                      # Watch mode
```

The `package.json` `test` script is `bun test` (`package.json:14`). There is no `coverage` script and no enforced coverage threshold.

---

## Test Inventory

| File | Coverage |
|------|----------|
| `src/excel/report-generator.test.ts` | 7-sheet Excel report generation (largest test file, 581 lines) |
| `src/api/wb-client.test.ts` | WB client factory + per-cabinet caching |
| `src/services/auth-service.test.ts` | JWT secret validation, Telegram HMAC, whitelist logic, replay protection |
| `src/services/cabinet-report.test.ts` | Per-cabinet send cooldown |
| `src/web/auth-middleware.test.ts` | Auth + admin middleware, JWT handling, cabinet access |
| `src/web/admin-routes.test.ts` | Admin route authorization |
| `src/web/cabinet-routes.test.ts` | Cabinet list/detail, API key stripping |
| `src/web/cabinet-context.test.ts` | Hono context helpers |
| `src/web/trigger-routes.test.ts` | `X-Trigger-Secret` webhook auth |

There are **no tests** for: the scheduler, sync services, smart bidder, keyword tracker, financial sync, monitoring repository, frontend components/hooks, CLI sync, emulator orchestrator. See CONCERNS.md for coverage gaps.

---

## Test File Organization

**Location:** Co-located with the file under test — `src/services/auth-service.ts` ↔ `src/services/auth-service.test.ts`. There is no separate `tests/` tree (the root-level `tests/` directory holds only `emu-proxy-diag.ts`, an ad-hoc diagnostic script, not a test).

**Naming:** `<source-stem>.test.ts`. Always `.test.ts`, never `.spec.ts`.

**Why co-location:** The codebase has no path aliases, so co-located tests can reuse the same relative imports as their target file (`from './report-generator'`, `from './auth-service'`).

---

## Test Structure

**Standard imports (every test file):**
```ts
import { test, expect, describe, mock, beforeEach } from 'bun:test';
```
Some files also pull `beforeAll`, `afterAll`, `afterEach` as needed.

**Suite organization (canonical pattern from `src/web/auth-middleware.test.ts`):**

```ts
// 1. Mock setup at the very top of the file
const mockVerifyToken = mock((token: string) => ({ userId: 1, ... }));
mock.module('../services/auth-service', () => ({
  verifyToken: mockVerifyToken,
  // ...other exports the consumer might touch
}));

// 2. Static import of the system under test AFTER mocks are registered
import { authMiddleware } from './auth-middleware';

// 3. Helpers
function createAuthApp() { ... }

// 4. describe blocks per public surface
describe('authMiddleware', () => {
  beforeEach(() => {
    mockVerifyToken.mockReset();
    mockVerifyToken.mockImplementation(() => ({ ... default ... }));
  });

  test('rejects request with no token (401)', async () => {
    const app = createAuthApp();
    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });
});
```

**Section markers:** Long test files use full-width comment banners to separate sections:
```ts
// ============================================================
// MOCK SETUP
// ============================================================
```
This style is consistent across `report-generator.test.ts`, `auth-middleware.test.ts`, `cabinet-routes.test.ts`, `admin-routes.test.ts`. New tests should follow it for files with multiple describe blocks.

---

## Mocking

### Module Mocking (`mock.module`)

`mock.module('<specifier>', factory)` replaces a module with the factory's return for the rest of the test file. **Module mocks must be registered BEFORE the system under test is imported.** Three patterns are used:

**Pattern A — top-level mocks + static import (most common):**
```ts
mock.module('../db/cabinets-repository', () => ({
  getCabinetsForUser: mockGetCabinetsForUser,
  userHasAccessToCabinet: mockUserHasAccessToCabinet,
  getCabinetById: mockGetCabinetById,
  // ...also stub every other export the module exposes, even if unused
  getActiveCabinets: mock(async () => []),
  isUserAllowed: mock(async () => true),
}));
import cabinetRoutes from './cabinet-routes';
```
See `src/web/cabinet-routes.test.ts:35-53`. **Stub every export** the consumed module exposes — Bun's module mock replaces the whole module, so missing exports become `undefined` and break unrelated code paths.

**Pattern B — top-level mocks + dynamic `await import()` inside test:**
```ts
mock.module('../db/cabinets-repository', () => ({ ... }));
test('...', async () => {
  const { checkWhitelist } = await import('./auth-service');
});
```
Used in `src/services/auth-service.test.ts:128-167` when different tests need different mock implementations of the same module — re-mock + re-import per test.

**Pattern C — per-test cache busting:**
```ts
async function freshApp() {
  const mod = await import('./trigger-routes?bust=' + Date.now());
}
```
See `src/web/trigger-routes.test.ts:19-24`. Used when the module reads `process.env` at import time and tests need different env per case.

### Mock Functions (`mock(...)`)

```ts
const mockSendTelegram = mock(async (_text: string) => {});
mockSendTelegram.mockClear();        // reset call history
mockSendTelegram.mockReset();        // reset history AND implementation
mockSendTelegram.mockImplementation(async () => { throw new Error('...'); });
expect(mockSendTelegram).toHaveBeenCalledTimes(1);
expect(mockSendTelegram).toHaveBeenCalledWith(5);
expect(mockSendTelegram).not.toHaveBeenCalled();
```

Convention: prefix mock variables with `mock` (`mockVerifyToken`, `mockGetCabinetById`, `mockSendTelegram`, `mockCreateAccount`).

Unused mock parameters get an underscore prefix to silence type warnings: `mock(async (_userId: number) => MOCK_CABINETS)` (`cabinet-routes.test.ts:31`).

### Reset Strategy

Use `beforeEach` inside each `describe` to re-establish a known mock baseline. Always reset BOTH the call history and the implementation:
```ts
beforeEach(() => {
  mockGetCabinetsForUser.mockReset();
  mockGetCabinetsForUser.mockImplementation(async () => MOCK_CABINETS);
});
```
See `src/web/cabinet-routes.test.ts:78-81`.

### Test-Only Escape Hatches

Production modules expose `_resetForTests`-style helpers when internal state must be cleared between tests. Example: `_resetCooldownForTests()` in `src/services/cabinet-report.ts:163`:
```ts
/** Test helper — clears cooldown state. Do not call from production code. */
export function _resetCooldownForTests() {
  lastSentByCabinet.clear();
}
```
Convention: leading underscore + `ForTests` suffix + JSDoc warning.

### What to Mock

- **Always mock**: external services (`db/connection`, `db/*-repository`, `services/auth-service`, `services/telegram-notifier`, `services/wbpartners-phone-db`)
- **Always mock**: things that hit the network or filesystem in unrelated ways
- **Always save-and-restore**: `process.env` reads via `process.env.X = '...'` in `beforeEach` and restore in `afterEach` (see `src/services/auth-service.test.ts:31-38`)

### What NOT to Mock

- **Hono itself**: tests construct real `new Hono()` apps and call `app.request('/path', { ... })` to exercise the full request lifecycle including middleware. See `src/web/cabinet-routes.test.ts:61-71`.
- **The system under test**: never mock the module you're testing.
- **`xlsx`, `crypto`, `jsonwebtoken`**: real implementations are used.

### Auth in Route Tests

Route tests bypass the real `authMiddleware` and inject context directly via a stub middleware:
```ts
function createTestApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId', 1);
    c.set('role', 'user');
    await next();
  });
  app.route('/', cabinetRoutes);
  return app;
}
```
See `src/web/cabinet-routes.test.ts:61-71`. Use this pattern when testing routes that require an authenticated user but where the auth flow itself is covered by `auth-middleware.test.ts`.

---

## Fixtures and Factories

### Inline Fixtures

Most tests inline fixtures at the top of the file as `const MOCK_X = [{ ... }, { ... }]`. Examples:
- `MOCK_PRODUCTS`, `MOCK_ANALYTICS`, `MOCK_ORDERS`, etc. in `src/excel/report-generator.test.ts:21-186` (10 fixtures, ~165 lines)
- `MOCK_CABINETS` in `src/web/cabinet-routes.test.ts:8-29`

### Mutable Fixture Pattern

When the same suite covers happy path + empty-data path, use a snapshot + mutable copy pattern:
```ts
const ORIGINAL_MOCK_DATA = { products: MOCK_PRODUCTS, ... };
let mockData = { ...ORIGINAL_MOCK_DATA };

mock.module('../db/repository', () => ({
  getProducts: mock(async () => mockData.products),  // closes over mutable
}));

describe('empty data', () => {
  beforeAll(() => { mockData = { products: [], ... }; });
  afterAll(() => { mockData = { ...ORIGINAL_MOCK_DATA }; });
});
```
See `src/excel/report-generator.test.ts:188-208` and `:469-494`.

### Factory Functions

For input-driven tests where each test needs slightly different shape, use a factory:
```ts
function makeAuthData(overrides: Record<string, any> = {}) {
  const base = { auth_date: ..., id: 999, ..., ...overrides };
  base.hash = createHmac(...).update(...).digest('hex');
  return base;
}
```
See `src/services/auth-service.test.ts:40-55`. The factory computes derived fields (HMAC hash) so tests can't accidentally produce invalid fixtures.

### Helpers

Test-file-scoped helpers convert workbook bytes to assertions:
```ts
function getSheetRows(wb: XLSX.WorkBook, sheetName: string): any[][] { ... }
function getSheetData(wb: XLSX.WorkBook, sheetName: string): any[] { ... }
```
See `src/excel/report-generator.test.ts:306-316`. Pull repeated parsing into helpers when more than 2 tests need it.

---

## Coverage

**Target:** None enforced. There is no coverage report in CI, no `bun test --coverage` invocation in `package.json`, no coverage badge.

**Practical state:**
- Auth + cabinet middleware: well-covered
- Excel report: well-covered (4 describe groups, ~25 tests)
- Trigger webhook auth: well-covered
- Sync services / scheduler / smart-bidder / keyword-tracker / monitoring repo / financial-sync: **0 tests**
- React components and hooks: **0 tests**

**View coverage (manual):**
```bash
bun test --coverage    # supported by bun:test, but not run in any script
```

---

## Test Types

**Unit tests:** All current tests are unit tests in scope. Real third-party libraries (`hono`, `xlsx`, `jsonwebtoken`, `crypto`) are exercised; only application modules at the boundary (DB repos, auth service, external services) are mocked.

**Integration tests:** The route tests in `src/web/*.test.ts` are integration-style for the HTTP layer (full Hono app + middleware + handler) but stop at the DB boundary (repos are mocked). There are no end-to-end tests against a live MySQL or live WB API.

**E2E tests:** None. There is no Playwright/Cypress/Puppeteer setup. The `tests/emu-proxy-diag.ts` file is a manual diagnostic script for the emulator proxy, not an automated test.

---

## Common Patterns

### Async Testing

```ts
test('returns 401 for invalid/expired token', async () => {
  mockVerifyToken.mockImplementation(() => { throw new Error('Token expired'); });
  const app = createAuthApp();
  const res = await app.request('/api/test', {
    headers: { Authorization: 'Bearer expired-tok' },
  });
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.error).toContain('Invalid or expired');
});
```
- Tests are `async` whenever the SUT is.
- `await res.json()` once and reuse the body across multiple `expect`s.

### Error Testing

Synchronous throws — pass a thunk to `expect(...).toThrow`:
```ts
expect(() => assertJwtSecretConfigured('')).toThrow(/JWT_SECRET/);
expect(() => assertJwtSecretConfigured('a'.repeat(64))).not.toThrow();
```
See `src/services/auth-service.test.ts:6-25`.

Async rejections — use `rejects.toThrow`:
```ts
await expect(loginWithTelegram(payload as any))
  .rejects.toThrow(/expired|Invalid/);
```
See `src/services/auth-service.test.ts:94-95`.

For HTTP routes, errors are observed via `res.status` and the JSON body, not exceptions:
```ts
const res = await app.request('/api/cabinets/1');
expect(res.status).toBe(403);
const body = await res.json() as any;
expect(body.error).toBe('Access denied');
```

### Environment Variable Manipulation

```ts
let savedToken: string | undefined;
beforeEach(() => {
  savedToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'fake-bot-token-1234567890';
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
});
```
See `src/services/auth-service.test.ts:29-38`. Always save-and-restore — multiple tests in the same file may need different env, and other test files run in the same process.

### Filesystem Cleanup

When tests produce artifacts on disk:
```ts
const generatedFiles: string[] = [];
// ...tests push file paths during beforeAll...
afterAll(async () => {
  for (const fp of generatedFiles) {
    try { await unlink(fp); } catch {}
  }
});
```
See `src/excel/report-generator.test.ts:318` and `:574-580`. Bare `catch {}` is intentional — test cleanup must not fail the suite.

### Hono Request Construction

`app.request(path, init)` accepts the same init shape as `fetch`:
```ts
const res = await app.request('/api/trigger/cabinet-report/5', {
  method: 'POST',
  headers: { 'X-Trigger-Secret': process.env.TRIGGER_SECRET! },
});
```
For routes requiring JSON bodies, use `JSON.stringify(body)` and `Content-Type: application/json` (see `admin-routes.test.ts:79`).

---

## Python Testing (`WBPartners-Auto/`)

**Status:** No automated test suite. There is one ad-hoc test script (`WBPartners-Auto/test_build_key.py`) that exercises the dedup-key construction, but no `pytest` or `unittest` configuration, no test runner integration, no CI step.

**Verification approach in practice:**
- Manual: edit, `sudo systemctl restart wb-monitor.service`, `sudo journalctl -u wb-monitor.service -f`, observe.
- Migration scripts (`migrate_schema_strict_keys.py`, `cleanup_empty_wh.py`) are run once with `pre-migrate-YYYY-MM-DD` snapshots of `orders.db` left in the directory as a manual rollback path.
- The `recount_today.py` script also serves as a verification tool — re-scanning a known day produces a Telegram message with delta counts.

**If adding Python tests:** add `pytest` to `WBPartners-Auto/requirements.txt`, follow the standard `test_*.py` naming, and remember the SQLite DB is bind-mounted into the bidberry container — tests must use a temp DB path, never the real `orders.db`.

---

## CI

There is no CI configuration in the repository (no `.github/`, no `.gitlab-ci.yml`, no `Jenkinsfile`). Tests run only when invoked manually via `bun test`.

The pre-deploy convention is: `bun test` before `docker compose up -d --build` on `ostapLase`. Since this server IS production, regressions caught here are caught in production. Run tests before every deploy.

---

*Testing analysis: 2026-04-27*
