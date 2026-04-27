# Coding Conventions

**Analysis Date:** 2026-04-27

This codebase is bilingual: TypeScript (Bun runtime, the main app under `src/` and `public/app/`) and Python (the `WBPartners-Auto/` phone-scraping subsystem). Conventions diverge between the two — both are described below.

---

## Language Split

| Layer | Language | Files |
|-------|----------|-------|
| Backend (Hono API + scheduler + WB client) | TypeScript (Bun) | `src/**/*.ts` |
| Frontend (React 19 SPA) | TypeScript + JSX | `public/app/**/*.tsx`, `*.ts` |
| Phone-scraping monitor (uiautomator2 + Telegram bot + FastAPI) | Python 3 | `WBPartners-Auto/*.py` |

There is **no shared linter or formatter config** in the repo (`.eslintrc*`, `.prettierrc*`, `biome.json`, `pyproject.toml`, `.flake8` — none exist). Conventions below are derived from observed patterns, not enforced by tooling. New code must match the existing style by hand.

---

## TypeScript Conventions

### Compiler Setup

- Config: `tsconfig.json`
- `target`: `ESNext`, `module`: `Preserve`, `moduleResolution`: `bundler`
- `jsx`: `react-jsx` (no React import needed for JSX)
- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`
- `verbatimModuleSyntax: true` — type-only imports MUST be marked: `import type { Foo } from '...'`
- `allowImportingTsExtensions: true` — `.ts` extensions are allowed in imports but rare in practice (most imports are extensionless)
- `noUnusedLocals/Parameters` are intentionally **off** so dev iteration is not blocked

### File Naming

- **Source files**: lowercase + kebab-case → `src/services/cabinet-report.ts`, `src/db/cabinets-repository.ts`, `src/web/auth-middleware.ts`
- **Test files**: co-located with source as `*.test.ts` → `src/services/auth-service.test.ts`
- **React components/pages**: PascalCase `.tsx` → `public/app/components/dashboard/DashboardPage.tsx`, `public/app/App.tsx`
- **React hooks**: `useFoo.ts` or `useFoo.tsx` (`.tsx` when the hook ships a Provider component) → `public/app/hooks/useApi.ts`, `public/app/hooks/useCabinet.tsx`
- **Repositories**: `<entity>-repository.ts` → `cabinets-repository.ts`, `orders-repository.ts`, `monitoring-repository.ts`
- **Services**: `<feature>-service.ts` or `<feature>-sync.ts` → `orders-service.ts`, `financial-sync.ts`, `cabinet-report.ts`
- **Routes**: `<feature>-routes.ts` → `cabinet-routes.ts`, `trigger-routes.ts`, `admin-routes.ts`

### Identifier Naming

- **Functions**: `camelCase` — `upsertCampaign`, `getCabinetsForUser`, `syncOrdersFast`, `verifyTelegramAuth`
- **Variables / parameters**: `camelCase` — `cabinetId`, `wbClient`, `dateFrom`, `apiKey`
- **Classes**: `PascalCase` — `WBApiClient` (singleton with constructor + private fields)
- **TypeScript interfaces**: `PascalCase` — `DBCabinet`, `WBCampaign`, `JWTPayload`, `RetryOptions`. Convention: types are NOT prefixed with `I`. DB row shapes are prefixed `DB...` (`DBCabinet`, `DBOrder`, `DBSalesReport`). WB API shapes are prefixed `WB...` (`WBCampaign`, `WBOrder`, `WBProductAnalytics`).
- **DB column names** (in SQL strings, in interface fields representing rows): `snake_case` — `cabinet_id`, `nm_id`, `wb_api_key`, `last_sync_at`, `is_cancel`, `price_with_disc`. The `DB...` interfaces in `src/types/index.ts` use snake_case fields verbatim because mysql2 returns rows as plain objects with the SQL column names. WB API shapes use the camelCase keys WB returns (`advertId`, `nmId`, `cancelDate`).
- **Constants**: `SCREAMING_SNAKE_CASE` — `WB_API_BASE`, `DEFAULT_OPTIONS`, `NON_RETRYABLE_STATUS_CODES`, `MSK_OFFSET_HOURS`, `COOLDOWN_MS`, `JWT_ACCESS_TTL`
- **Test-only escape hatches**: prefix with underscore — `_resetCooldownForTests` in `src/services/cabinet-report.ts:163`. The leading `_` plus `ForTests` suffix is the agreed signal "do not call from production code".

### Imports

- Type-only imports MUST use `import type` (required by `verbatimModuleSyntax`):
  ```ts
  import type { WBApiClient } from '../api/wb-client';
  import type { DBCabinet } from '../types';
  ```
- Module imports use the `import * as ns from '...'` namespace pattern for repositories/services that export a flat collection of functions:
  ```ts
  import * as cabinetsRepo from '../db/cabinets-repository';
  import * as monitoringRepo from '../db/monitoring-repository';
  import * as ordersService from '../services/orders-service';
  ```
- Default exports are reserved for Hono sub-apps (`export default app;` in every `*-routes.ts`) and React page components (`export default function DashboardPage()`)
- Named exports for everything else (functions, types, constants, classes)
- No path aliases configured — relative paths everywhere (`../db/connection`, `../utils/retry`)
- No barrel files except `src/types/index.ts` (single file holding all shared types)
- Bun built-ins are preferred over Node — `Bun.sleep(500)`, `Bun.serve()`, `Bun.file(...)` instead of `setTimeout`, `express`, `fs/promises`. Confirmed by `CLAUDE.md`.

### Module Layering

- `src/db/*` is the data layer — no service or HTTP knowledge. Functions take `cabinetId: number` as the first argument and execute raw SQL via `query`/`execute`/`transaction` from `src/db/connection.ts`.
- `src/services/*` is the business-logic layer — depends on `db/*` and `api/wb-client.ts`. Sync services accept `(cabinetId: number, wbClient: WBApiClient, ...)`.
- `src/web/*` is the HTTP layer — Hono routers per feature. Each file exports a default Hono app and reads `cabinetId` from the request context, never as a parameter.
- `src/api/wb-client.ts` is the only place that talks to WB. All outbound calls go through `WBApiClient.request()` which wraps `fetch` with `withRetry`.
- Crossing layers backwards (e.g. `db/` importing from `services/`) does not occur and must not be introduced.

### Error Handling

- WB API: every outbound call is wrapped in `withRetry` from `src/utils/retry.ts`. The wrapper:
  - Retries on `429, 500, 502, 503, 504` (configurable via `retryableStatusCodes`)
  - Never retries on `400, 401, 403, 404` (`NON_RETRYABLE_STATUS_CODES` in `retry.ts:17`)
  - Honors `Retry-After` on 429
  - Default backoff: `baseDelayMs=1000`, doubles per attempt, capped at `maxDelayMs=60000`, `maxRetries=3`
- Sync tasks: per-item try/catch with `errors++` counter so one bad campaign/product doesn't abort the whole batch. See `src/index.ts:144-170` (`products-sync`) for the canonical pattern. The import record's final status is `'completed' | 'partial' | 'error'` based on `errors` and `totalSynced`.
- Per-cabinet error isolation in the scheduler: `forEachCabinet()` in `src/index.ts:48-62` catches per-cabinet failures and logs them as `[Scheduler] <task> failed for cabinet <id>` instead of stopping the run.
- HTTP routes: shape is `try { ... } catch (error: any) { return c.json({ error: error.message }, 500); }`. See `src/web/cabinet-routes.ts:11-15`. Distinct status codes are used for known cases (401 unauth, 403 access denied, 404 not found, 400 bad input).
- Untyped catches use `error: any` because WB API errors and mysql2 errors are not properly typed; the message string is the only field consistently used.
- Bare `catch {}` (no binding) is used to silently absorb expected failures: cleanup in tests, fetch fallbacks, ignored optional reads (`useCabinet.tsx:48`, `auth-service.ts:82`).
- Errors are normalized to `Error` when needed: `lastError = error instanceof Error ? error : new Error(String(error));` (`retry.ts:40`).

### Logging

- Framework: plain `console.log` / `console.warn` / `console.error`. No structured logger (no winston/pino).
- Standard prefix format: `[<subsystem>] <message>` — examples:
  - `[Scheduler] Cabinet ${cabinetId} campaigns synced: ${count}`
  - `[financial-sync] Cabinet ${cabinetId}: synced ${count} expenses`
  - `[trigger] cabinet-report ${cabinetId} failed: ${err.message}`
  - `[retry] Attempt ${nextAttempt}/${opts.maxRetries} failed: ...`
  - `[startup] FATAL: ...`
- CLI sync uses helper functions `log` / `logError` defined per-file (`src/cli/sync.ts:19-25`) prefixed with `[sync]`.
- Logs are tailed via `docker compose logs -f app` and `journalctl -u wb-monitor.service -f` — assume any string going to stdout/stderr ends up there.

### Async / Promise Style

- `async/await` everywhere — no raw `.then()` chains in business logic
- Top-level service functions return `Promise<T>` with explicit return types
- Fire-and-forget background work uses `.catch(err => console.error(...))` — see `src/web/trigger-routes.ts:56-58` (`sendCabinetReport(cabinetId).catch(...)`) and `src/index.ts:36-39` (migration).
- Concurrency is sequential by default (`for...of` over `cabinets`, `for...of` over batches) — there is no `Promise.all` over cabinets because errors must isolate per-cabinet. Batches use `await Bun.sleep(...)` between iterations to respect WB rate limits.

### Comments

- Multi-line comment header on non-trivial files explaining purpose, source-of-truth, and any non-obvious invariants. Examples:
  - `src/services/cabinet-report.ts:1-10` — documents that orders come from the phone DB, not the WB API
  - `src/web/trigger-routes.ts:1-8` — documents the `X-Trigger-Secret` auth boundary and 127.0.0.1 binding
- JSDoc block comments on exported functions when behavior is subtle. E.g. `assertJwtSecretConfigured` (`src/services/auth-service.ts:31-42`) has a multi-paragraph JSDoc explaining why the function takes a parameter for tests.
- Inline comments explain *why*, not *what* — see `src/api/wb-client.ts:47` (`signal: AbortSignal.timeout(60000)`), `src/db/orders-repository.ts:21` (`order_id kept for display only; dedup is via unique(cabinet_id, srid)`).
- WB API comments are often in Russian (`// Получить список рекламных кампаний` — `src/api/wb-client.ts:69`) because they mirror the WB official docs which are Russian-only.
- TODO/FIXME comments are uncommon — concerns are tracked elsewhere (typically in commit messages). When found, they should be migrated to CONCERNS.md.

### Function Design

- Functions are small and single-purpose — `src/services/orders-service.ts` is 23 lines and exports 4 functions, each delegating to the repo with date defaults.
- First parameter is almost always `cabinetId: number` for any function that touches tenant data — this is the multi-tenancy contract. See every function in `src/db/*-repository.ts`.
- Optional parameters use `?:` not `| undefined` — `dateFrom?: string`
- Default values inline at the call site or destructured at the top: `const from = dateFrom || dayjs().subtract(30, 'day').format('YYYY-MM-DD');`
- Return types are explicit on exported functions (helps when consuming functions are written without local type inference).

### Multi-Tenancy Pattern

- Every DB query must include `WHERE cabinet_id = ?`. This is enforced by convention — there is no ORM scope/policy.
- Schema convention: every tenant-scoped table has `cabinet_id INT NOT NULL` as a leading column and a composite unique key like `(cabinet_id, srid)` (`orders-repository.ts:21`).
- Routes pull `cabinetId` from the Hono context, set by `authMiddleware` (`src/web/auth-middleware.ts:36-50`):
  ```ts
  const userId = c.get('userId' as never) as number;
  // route then calls cabinet-aware repos / services
  ```
- The `getCabinetId(c)` / `getWBClientFromContext(c)` helpers in `src/web/cabinet-context.ts` throw with explicit messages when the context is missing.
- Services that fan out across cabinets use `forEachCabinet(taskName, async (cabinetId, wbClient) => { ... })` from `src/index.ts:48`. Always wrap your task body so a single cabinet failure does not break others.

### SQL Style

- Raw SQL only (no ORM, no query builder). mysql2 placeholder is `?`.
- INSERT … ON DUPLICATE KEY UPDATE is the canonical upsert (`src/db/repository.ts:17`, `src/db/orders-repository.ts:5`). Always upsert idempotently — sync tasks re-run.
- Multi-line SQL strings use backticks with leading whitespace and SQL keywords UPPERCASE.
- Query returns are typed via the generic on `query<T>`: `query<DBCabinet[]>(...)`. Use `rows[0] || null` for "find one" queries.
- Always pass parameters as the second argument of `query`/`execute`. Never interpolate values into the SQL string.
- Transactions go through `transaction(async (conn) => { ... })` (`src/db/connection.ts:74`). The wrapper handles `beginTransaction` / `commit` / `rollback` / `release`.

### React / Frontend

- Hooks live under `public/app/hooks/`. Context-bearing hooks export both a `Provider` component and a `use<Name>()` getter (see `useCabinet.tsx`).
- `api()` from `public/app/hooks/useApi.ts` is the only HTTP entry point in the frontend. It auto-injects `Authorization: Bearer ${token}` and `X-Cabinet-Id: ${cabinetId}` from `localStorage`.
- `api()` auto-handles 401 by clearing the token and reloading the page (`useApi.ts:13-17`).
- Pages are default-exported from `public/app/components/<feature>/<Page>.tsx` and registered in `public/app/App.tsx` as routes.
- Styling is Tailwind utility classes inline. No CSS modules, no styled-components.
- Charts use Chart.js loaded via dynamic ESM import from a CDN (`DashboardPage.tsx:36-49`) — no bundling step, since this is Bun's HTML-import flow.
- State management is local + custom hooks; no Redux, no Zustand.
- No barrel `index.ts` per directory — components are imported by file path.

### Module Exports

- Named exports for utilities, services, and DB functions
- Default exports for Hono routers and React page components
- Re-exports are rare; barrel-only file is `src/types/index.ts`

---

## Python Conventions (`WBPartners-Auto/`)

### Runtime & Setup

- Python 3 (system `python3` plus a per-project venv at `WBPartners-Auto/venv/`)
- Dependencies in `WBPartners-Auto/requirements.txt`: `uiautomator2`, `python-telegram-bot[socks]`, `python-dotenv`, `requests`, `Pillow`, `fastapi`, `uvicorn[standard]`
- Loaded under systemd: `wb-monitor.service` runs `venv/bin/python3 wb_order_monitor.py`. Restart with `sudo systemctl restart wb-monitor.service` after any edit (no hot-reload).

### File / Module Naming

- Files: `snake_case.py` — `wb_order_monitor.py`, `db.py`, `bot.py`, `api.py`, `recount_today.py`, `migrate_schema_strict_keys.py`
- One module per concern, flat layout (no packages). Cross-imports are direct: `from db import init_db, upsert_order`, `from bot import run_bot_thread`.

### Identifier Naming

- **Functions / variables**: `snake_case` — `upsert_order`, `get_recent_orders`, `parse_russian_date`, `format_order`, `flush_pending_telegram`
- **Module-level constants**: `SCREAMING_SNAKE_CASE` — `DB_PATH`, `MONTHS_RU`, `SCHEMA`, `PENDING_TG_MAX_ROWS`, `REFRESH_INTERVAL`, `TG_MAX_ATTEMPTS`, `TG_TOTAL_BUDGET_SEC`
- **Module-level mutable state**: leading underscore — `_consecutive_errors`, `_last_stuck_alert_ts`, `_recovering`, `_last_collect_reason` in `wb_order_monitor.py:53-57`. Comment notes "module-level so handle_error_state can escalate across cycles."
- **Internal helpers**: leading underscore — `_send_telegram_once`, `_chunk_messages`
- **Pydantic models** (FastAPI): `PascalCase` with `Response`/`Request` suffix — `OrderResponse`, `StatsResponse`, `HealthResponse`, `StatusCount` (`api.py:36-67`)
- Type hints: PEP 604 unions are NOT used; `Optional[X]` style (`Optional[str] = None`) is preferred (`api.py:48`). `set[str]` and `list[StatusCount]` builtin generics are used (`recount_today.py:67`, `api.py:62`).

### Module Header

- File-level docstring (one line): `"""SQLite database layer for WB Partners order storage."""` (`db.py:1`)
- Shebang only on entrypoint scripts: `#!/usr/bin/env python3` at the top of `wb_order_monitor.py` and `recount_today.py`

### Imports

- Stdlib first (`import os`, `import time`, `from datetime import ...`)
- Third-party next (`import requests`, `from fastapi import ...`, `from telegram.ext import ...`)
- Local last (`from db import ...`, `from bot import ...`)
- Groups separated by a blank line
- `load_dotenv()` is called at module top-level immediately after imports (`bot.py:16`, `api.py:26`, `wb_order_monitor.py:24`). The TS side does NOT use dotenv — Bun loads `.env` automatically.
- Env access: `os.getenv("VAR_NAME")` with explicit defaults where applicable: `int(os.getenv("API_PORT", "22001"))`

### Error Handling

- Telegram send: bounded retry with explicit budget (`TG_TOTAL_BUDGET_SEC = 120`) and dedicated 429 handling that respects `retry_after` from Telegram's response (`wb_order_monitor.py:75-138`). The same retry philosophy as TS `withRetry`: never retry on permanent 4xx (`> Other 4xx — bad payload, retrying won't help`), retry on 429 + 5xx with backoff.
- Persistent failure queue: `pending_telegram` table in SQLite holds messages that exhausted their retry budget; `flush_pending_telegram()` at the top of each monitor cycle drains the queue (`wb_order_monitor.py:154-175`).
- DB integrity: `INSERT` rather than `INSERT OR IGNORE` so CHECK/NOT NULL violations are loud while UNIQUE collisions are caught and returned as `False` (`db.py:157-207`). The comment block at `db.py:159-164` explicitly justifies this choice.
- Background HTTP triggers are fire-and-forget with very short timeouts: `requests.post(url, timeout=3)` plus `try/except Exception as e: print(...)` — see `wb_order_monitor.py:60-72`.

### Logging

- Plain `print()` to stdout. `journalctl -u wb-monitor.service -f` is the log tail.
- Log lines are indented with two spaces for sub-events under a top-level cycle log: `f"  Telegram 429, sleeping {wait}s"`. This is a visual hierarchy convention, not enforced.

### Comments

- Function docstrings: triple-quoted single-line for short helpers, multi-paragraph for non-trivial ones. Long docstrings explain *why* and document return-shape contracts: `_send_telegram_once` in `wb_order_monitor.py:75-83` documents the `(ok, reason)` tuple return.
- Module-level comments justify schema/protocol choices that look weird at first glance — e.g. `db.py:64-72` explains why `journal_mode=DELETE` is used instead of `WAL` (the bind-mounted file would not see WAL writes).

### SQLite Style

- Connection per call: `get_connection()` opens, work happens, `conn.close()` in `finally`. No connection pool — single writer, infrequent writes.
- `conn.row_factory = sqlite3.Row` so rows behave like dicts: `o["status"]`, `o["article"]`.
- `journal_mode=DELETE` (NOT WAL) — deliberately chosen for the bind-mount scenario; do not change.
- Schema lives in a triple-quoted `SCHEMA` constant and is applied via `conn.executescript(SCHEMA)` plus idempotent `ALTER TABLE` migrations in `init_db()` (`db.py:75-87`). Every fresh boot runs migrations.
- Hardcoded CHECK constraints enforce data quality at the DB level (`db.py:18-31`): `length(article) > 0`, `price_cents > 0`, etc.

### FastAPI Style

- API key auth via `APIKeyHeader(name="X-API-Key")` + `Security` dependency injection (`api.py:73-78`).
- Pydantic models for every response shape; routes use `response_model=...`.

### Telegram Bot Style

- Decorator-gated handlers: `@restricted` (defined in `bot.py:22-29`) checks `update.effective_chat.id == TELEGRAM_CHAT_ID` and silently drops messages from other chats. Apply to every command handler.
- All UI text is Russian (matches the seller's WB Partners workflow). Use Russian status names verbatim: `Заказ`, `Отказ`, `Выкуп`, `Возврат`.

---

## Cross-Cutting Conventions

### Dates & Times

- Dates flowing in from WB / out to clients use ISO `YYYY-MM-DD` strings. `dayjs()` is the formatter on the TS side (`dayjs().subtract(7, 'day').format('YYYY-MM-DD')`).
- DATETIMEs in MySQL are stored as Moscow wall-clock (no TZ) — see `src/services/cabinet-report.ts:50-56` for the pattern, `nowMsk = dayjs().add(MSK_OFFSET_HOURS, 'hour')`. Comment block at `cabinet-report.ts:48-56` documents this.
- `date_parsed` in the SQLite phone DB is also MSK wall-clock as ISO string with `T` separator. `cabinet-report.ts:60-62` translates between the two formats by replacing `' '` with `'T'`.
- `MSK_OFFSET_HOURS = 3` is the canonical constant (`cabinet-report.ts:18`).

### Russian Text

- User-facing strings (Telegram messages, Excel sheet headers, frontend labels) are Russian.
- Code identifiers, log lines, and comments documenting protocol/architecture stay in English.
- Excel report sheet names are Russian Cyrillic literals — `'Воронка'`, `'Лента заказов'`, `'Остатки'`, `'Точки входа'`, `'Маркетинг'`, `'Рекламные компании'`, `'Кластеры'` (`src/excel/report-generator.test.ts:296-304`).

### Money

- Prices: integers as kopecks (Russian cents) in the SQLite phone DB (`price_cents`), but rubles as numbers (TypeScript `number`) in MySQL (`price`, `price_with_disc`, `finished_price`).
- Display formatting: `formatRubles(amount)` in `src/services/cabinet-report.ts:20-23` rounds to integer rubles, formats with `ru-RU` locale, and appends ` ₽`.

### Secrets & Auth

- `JWT_SECRET` is verified at boot via `assertJwtSecretConfigured()` (`src/services/auth-service.ts:43`). Empty, default placeholder, or `< 32` chars → process exits.
- `TRIGGER_SECRET` for webhook auth is verified per-request with constant-time compare (`src/web/trigger-routes.ts:17-27`). Required `>= 16` chars; otherwise all calls 401.
- Telegram HMAC is verified with `crypto.timingSafeEqual` after a length-equality guard (`src/services/auth-service.ts:79-84`).
- WB API keys are stored per-cabinet in MySQL (`cabinets.wb_api_key`). Routes that return cabinet data MUST strip the key — see `src/web/cabinet-routes.ts:11` (`cabinets.map(({ wb_api_key, ...rest }) => rest)`).
- Never log the WB API key, JWT, or `X-Trigger-Secret`. Errors should reference WB endpoint URLs but never headers.

---

*Convention analysis: 2026-04-27*
