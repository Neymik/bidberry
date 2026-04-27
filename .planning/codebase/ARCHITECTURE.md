<!-- refreshed: 2026-04-27 -->
# Architecture

**Analysis Date:** 2026-04-27

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                  React 19 SPA  (`public/app/`)                       │
│   App.tsx routes 9 pages → calls /api/* via `hooks/useApi.ts`        │
│   Sends `Authorization: Bearer <jwt>` + `X-Cabinet-Id: <id>` headers │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ HTTP (same origin, port 3000)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│           Bun.serve + Hono API   (`src/index.ts`)                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  HTML routes → `public/index.html` (9 SPA paths)             │   │
│  │  fetch → Hono `api` (`src/web/routes.ts`)                    │   │
│  │    • `authRoutes`  + `triggerRoutes` (no JWT)                │   │
│  │    • `authMiddleware` enforces JWT + cabinet access for /api │   │
│  │    • 17+ route modules mounted (see Component table)         │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Scheduler (`src/services/scheduler.ts`) — 19 setInterval    │   │
│  │  tasks. Each runs `forEachCabinet(name, fn)` → per-cabinet   │   │
│  │  isolated try/catch; calls services via `WBApiClient`.       │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────┬─────────────────────────────────────────────┬────────────────┘
       │                                              │
       ▼                                              ▼
┌──────────────────────────┐         ┌─────────────────────────────────┐
│  WB API (7 base URLs)     │         │  MySQL 8.0 pool (mysql2/promise)│
│  `src/api/wb-client.ts`   │         │  `src/db/connection.ts`         │
│  • Per-cabinet client     │         │  • All tables scoped by         │
│    cache by cabinetId     │         │    `cabinet_id`                 │
│  • `withRetry` (`utils/   │         │  • Repositories return DB rows  │
│    retry.ts`) for 429/5xx │         │    (`src/db/*-repository.ts`)   │
└──────────────────────────┘         └─────────────────────────────────┘

                    ───── Out-of-band, authoritative ─────

┌─────────────────────────────────────────────────────────────────────┐
│  WBPartners-Auto (Python, systemd-supervised)                        │
│  `WBPartners-Auto/wb_order_monitor.py`                               │
│   • uiautomator2 drives WB Partners Android app on Huawei phone      │
│   • Parses order feed every 180s → SQLite `WBPartners-Auto/orders.db`│
│   • Telegram bot `bot.py`, FastAPI `api.py`                          │
│   • POSTs `/api/trigger/cabinet-report/:cabinetId` on new orders     │
└──────────────────────────────────────┬──────────────────────────────┘
                                       │ read-only bind mount
                                       ▼
                  `/mnt/wbpartners/orders.db`  (in app container)
                  read by `src/services/wbpartners-phone-db.ts`
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Bun entry | HTML+API server, JWT bootstrap, scheduler boot, allowed_users migration | `src/index.ts` |
| Hono router | Mounts 17 sub-route modules; declares `/api/*` auth fence | `src/web/routes.ts` |
| Auth middleware | Verifies JWT, sets `cabinetId`/`cabinetApiKey` in Hono context | `src/web/auth-middleware.ts` |
| Cabinet context | Per-request helpers `getCabinetId(c)`, `getWBClientFromContext(c)` | `src/web/cabinet-context.ts` |
| Trigger router | Webhook surface for WBPartners-Auto, gated by `X-Trigger-Secret` | `src/web/trigger-routes.ts` |
| Scheduler core | `registerTask`/`start`/`stop` driven by `setInterval`; status snapshot | `src/services/scheduler.ts` |
| Scheduler tasks | 19 scheduled jobs (`forEachCabinet` wrapper per task) | `src/index.ts` (lines 65–554) |
| WB API client | Singleton-per-cabinet client across 7 WB API base URLs, retries | `src/api/wb-client.ts` |
| Retry helper | Exponential backoff, honours `Retry-After`, status-class gating | `src/utils/retry.ts` |
| MySQL pool | Lazily-built pool, `query`/`execute`/`transaction` helpers | `src/db/connection.ts` |
| Repositories | Per-domain CRUD + multi-tenant (`cabinet_id`) scoping | `src/db/*-repository.ts` |
| Cabinet/account model | Accounts ↔ users (M:N) ↔ cabinets (1:N), each cabinet has its own WB key | `src/db/cabinets-repository.ts`, `docker/init.sql` |
| Cabinet report builder | Joins phone-DB orders with WB-API spend → Telegram message | `src/services/cabinet-report.ts` |
| Phone DB reader | Read-only `bun:sqlite` access to phone scrape DB | `src/services/wbpartners-phone-db.ts` |
| Emulator orchestrator | Provisions Redroid + ws-scrcpy + monitor container trios | `src/services/emulator-orchestrator.ts` |
| Docker client | Talks to Docker Engine API via mounted `/var/run/docker.sock` | `src/services/docker-client.ts` |
| React shell | Auth/Cabinet/DateRange/Toast providers + 9 page routes | `public/app/App.tsx` |
| API client (FE) | Adds `Authorization` and `X-Cabinet-Id` to every fetch | `public/app/hooks/useApi.ts` |
| Phone monitor | uiautomator2 orchestrator — scrape, persist, notify | `WBPartners-Auto/wb_order_monitor.py` |
| Phone DB writer | SQLite schema + upsert for the phone-scraped orders | `WBPartners-Auto/db.py` |
| Phone REST API | FastAPI read-only orders API for cross-machine consumers | `WBPartners-Auto/api.py` |
| Phone Telegram bot | `/count`, `/orders`, etc. against the phone DB | `WBPartners-Auto/bot.py` |

## Pattern Overview

**Overall:** Modular monolith (Bun + Hono) with a sidecar Python automation process. The TS app is a layered single-process server (HTTP routes → services → repositories → MySQL pool) with an internal scheduler. Multi-tenancy is enforced as a row-level filter (`cabinet_id`) rather than per-tenant schemas/DBs. The Python `WBPartners-Auto/` subsystem is an independent process tree, integrated via (a) a read-only SQLite bind mount and (b) outbound HTTP webhooks into the Hono trigger routes.

**Key Characteristics:**
- Single Bun process serves both static SPA assets (`public/index.html` via HTML imports) and the Hono `/api/*` surface — no separate frontend build/server.
- Per-cabinet error isolation: `forEachCabinet` in `src/index.ts` wraps every scheduler task in try/catch so one cabinet's failure cannot stop sync for the others.
- WB API treated as untrusted and unreliable. Order ground-truth lives in the Python phone scraper's SQLite; WB API fills only the data the phone cannot observe (ad spend, balances, budgets).
- Two-language, two-process system glued by a file (`orders.db`) and a single internal HTTP webhook (`/api/trigger/cabinet-report/:cabinetId`).
- No ORM. Repositories are thin SQL functions; multi-tenant scoping is a manual `WHERE cabinet_id = ?` discipline.

## Layers

**Presentation (SPA):**
- Purpose: Render dashboards, manage cabinets, drive imports/exports
- Location: `public/app/`
- Contains: React 19 components (`components/<page>/`), context-based hooks (`hooks/`), Tailwind globals (`styles/globals.css`)
- Depends on: `/api/*` over fetch via `useApi.ts`
- Used by: `public/index.html` (entry script)

**HTTP routing:**
- Purpose: Translate HTTP into service calls, enforce auth and cabinet access
- Location: `src/web/`
- Contains: Hono apps per domain (`*-routes.ts`), `auth-middleware.ts`, `cabinet-context.ts`
- Depends on: `src/services/*`, `src/db/*-repository.ts`
- Used by: `src/web/routes.ts` (mounted into `src/index.ts`)

**Services (business logic):**
- Purpose: Domain orchestration, cross-repo coordination, scheduling, integrations
- Location: `src/services/`
- Contains: scheduler engine, syncers (`orders-service.ts`, `stock-service.ts`, `financial-sync.ts`), `smart-bidder.ts`, `keyword-tracker.ts`, `search-analytics-service.ts`, `cabinet-report.ts`, emulator orchestration, `auth-service.ts`, `telegram-notifier.ts`, `wbpartners-phone-db.ts`
- Depends on: `src/db/*`, `src/api/wb-client.ts`, `src/utils/*`
- Used by: route handlers and the scheduler in `src/index.ts`

**Data access:**
- Purpose: SQL CRUD for each domain, all scoped by `cabinet_id`
- Location: `src/db/`
- Contains: `connection.ts` (pool), 13 `*-repository.ts` modules, `index.ts` re-exports
- Depends on: `mysql2/promise` only
- Used by: services and route handlers

**External integration:**
- Purpose: Talk to Wildberries cloud APIs and Telegram
- Location: `src/api/`, `src/services/telegram-notifier.ts`
- Contains: `WBApiClient` covering 7 WB API hosts (advert, analytics, content, statistics, prices, calendar, advert-media)
- Depends on: `src/utils/retry.ts`
- Used by: services

**Sidecar automation (Python):**
- Purpose: Authoritative order capture from the Wildberries Partners Android app
- Location: `WBPartners-Auto/`
- Contains: `wb_order_monitor.py` (orchestrator), `db.py` (SQLite), `bot.py` (Telegram), `api.py` (FastAPI), `migrate*.py`, `recount_today.py`, `cleanup_empty_wh.py`
- Depends on: physical Huawei phone over ADB; `uiautomator2`, `python-telegram-bot`, `fastapi`, `requests`
- Used by: bidberry app via read-only bind mount of `orders.db` and webhook calls to `/api/trigger/cabinet-report/:cabinetId`

## Data Flow

### Primary Request Path (authenticated SPA call)

1. Browser hits a SPA path (`/`, `/campaigns`, …) — Bun's `routes` map serves `public/index.html` (`src/index.ts:589-600`).
2. React app boots (`public/app/main.tsx:1-12`), `AuthProvider`/`CabinetProvider` load JWT + cabinet list, the user picks a cabinet which is persisted to `localStorage`.
3. Components call `api(...)` (`public/app/hooks/useApi.ts:1-40`) which appends `Authorization: Bearer <jwt>` and `X-Cabinet-Id`.
4. Bun's `fetch` delegates to Hono (`src/index.ts:601`), which routes to one of the sub-apps in `src/web/routes.ts`.
5. `authMiddleware` (`src/web/auth-middleware.ts:6-57`) verifies the JWT, looks up cabinet access in `cabinets-repository`, and sets `cabinetId`/`cabinetApiKey` on the Hono context.
6. The route handler grabs them via `getCabinetId(c)` / `getWBClientFromContext(c)` (`src/web/cabinet-context.ts:8-26`).
7. Handler calls a service (`src/services/*`), which goes to a repository (`src/db/*-repository.ts`) — every query carries the `cabinet_id`.
8. Response JSON returns to the SPA.

### Scheduler Flow

1. `src/index.ts` calls `scheduler.registerTask(name, intervalMs, callback)` 19 times (lines 65–554).
2. `scheduler.start()` is invoked once unless `NODE_ENV === 'test'` (`src/index.ts:557-559`).
3. Each `setInterval` tick checks `task.status === 'running'` and skips overlap (`src/services/scheduler.ts:32-46`) — single-flight per task.
4. The callback typically runs `forEachCabinet(name, fn)` (`src/index.ts:48-62`), iterating active cabinets sequentially with a per-cabinet try/catch.
5. Service code creates an import record (`repo.createImportRecord(...)`), does the WB API + DB work, and finalises the record with `completed`/`partial`/`error`.
6. Errors set `task.status = 'error'` and `task.lastError`; the next tick retries.

### Cross-Language Phone ↔ WB-API Flow (Cabinet Report)

1. Huawei phone running WB Partners app is driven by `wb_order_monitor.py` (every ~180s) using `uiautomator2`.
2. Parsed orders are upserted into `WBPartners-Auto/orders.db` (`WBPartners-Auto/db.py:upsert_order`).
3. On a new order, `trigger_bidberry_report()` (`WBPartners-Auto/wb_order_monitor.py:60-72`) POSTs to `http://127.0.0.1:3000/api/trigger/cabinet-report/<cabinetId>` with `X-Trigger-Secret`.
4. `triggerRoutes` validates the secret in constant time (`src/web/trigger-routes.ts:17-46`) and accepts the request (202 immediately).
5. `sendCabinetReport(cabinetId)` (`src/services/cabinet-report.ts`) computes the MSK midnight window:
   - **Authoritative orders** come from `getPhoneTotalsByArticle(fromIso, toIso)` (`src/services/wbpartners-phone-db.ts:50-74`) which `bun:sqlite`-reads `/mnt/wbpartners/orders.db` (read-only bind mount declared in `docker-compose.yml:57`).
   - **Ad spend / WB API orders** come from `monitoring-repository.ts` tables populated by the `financial-sync` and `orders-sync*` scheduler tasks via `WBApiClient`.
6. Joined report text is sent to Telegram via `telegram-notifier.ts`.
7. Same code path also runs on the `cabinet-report` scheduler (every 15 min, `src/index.ts:533-544`) and behind a GET query-window variant used by the Python Telegram bot's `/count` (`src/web/trigger-routes.ts:74-103`).

**State Management:**
- Backend: stateless except for the lazy MySQL pool (`src/db/connection.ts:4`), the in-memory `WBApiClient` cache keyed by cabinetId (`src/api/wb-client.ts:628`), and the scheduler's `Map<string, ScheduledTask>` (`src/services/scheduler.ts:13`).
- Frontend: React Context (`AuthProvider`, `CabinetProvider`, `DateRangeProvider`, `ToastProvider`) plus `localStorage` for `token` and `selectedCabinetId`.
- Python: SQLite is the only persistent store; module-level recovery counters in `wb_order_monitor.py` (e.g. `_consecutive_errors`).

## Key Abstractions

**Cabinet (`DBCabinet`):**
- Purpose: A Wildberries seller account (its own WB API key); the unit of multi-tenancy
- Examples: `src/db/cabinets-repository.ts`, every `*-repository.ts`'s `WHERE cabinet_id = ?` clause
- Pattern: All domain rows carry `cabinet_id`; access governed by `accounts ↔ user_accounts ↔ cabinets` (M:N+1:N) defined in `docker/init.sql:8-50`

**`forEachCabinet` task wrapper:**
- Purpose: Run an arbitrary scheduled job for every active cabinet with error isolation and `lastSync` bookkeeping
- Examples: `src/index.ts:48-62` (definition), used 18 times in the same file
- Pattern: Higher-order function; the task body never sees cross-cabinet leakage

**`WBApiClient` per-cabinet factory:**
- Purpose: One API client instance per cabinet, reused across calls; keeps the WB API key encapsulated
- Examples: `src/api/wb-client.ts:626-648` (`getWBClientForCabinet` / `invalidateCabinetClient`)
- Pattern: Memoised factory; cache is cleared explicitly when an admin rotates a cabinet's API key

**Hono context as request-scoped DI:**
- Purpose: Carry `userId`, `telegramId`, `role`, `cabinetId`, `cabinetApiKey` per request
- Examples: `src/web/auth-middleware.ts:23-50`, accessed via `c.get('cabinetId' as never)`
- Pattern: Set-once in middleware, read in handlers via the helpers in `src/web/cabinet-context.ts`

**Import record (sync audit log):**
- Purpose: Persist start/end + status/count/errorMessage of every sync run
- Examples: `repo.createImportRecord(...)` / `repo.updateImportRecord(...)` invoked at the head and tail of every scheduler task and CLI command in `src/cli/sync.ts`
- Pattern: Wrap-the-work bookkeeping; statuses are `completed | partial | error`

**Phone DB as authoritative order store:**
- Purpose: Decouple from unreliable WB Statistics API for order counting
- Examples: `src/services/wbpartners-phone-db.ts`, `WBPartners-Auto/db.py`
- Pattern: Single-writer SQLite file (DELETE journal mode for bind-mount visibility), read-only consumer in TS; all "from MSK midnight" windows query `date_parsed`

**Trigger webhook + shared secret:**
- Purpose: Allow the local Python process to invoke bidberry actions without a JWT
- Examples: `src/web/trigger-routes.ts`, `WBPartners-Auto/wb_order_monitor.py:trigger_bidberry_report`
- Pattern: Constant-time `X-Trigger-Secret` comparison, 401 on mismatch; mounted before `authMiddleware` in `src/web/routes.ts:37-47`

## Entry Points

**Backend boot:**
- Location: `src/index.ts`
- Triggers: `bun run src/index.ts` (Dockerfile `CMD`); `package.json scripts.start` and `dev`
- Responsibilities: Validate `JWT_SECRET`, run idempotent migrations, register 19 scheduler tasks, start scheduler, start `Bun.serve` (host 127.0.0.1, port `APP_PORT`)

**HTML/SPA:**
- Location: `public/index.html` → `public/app/main.tsx` → `public/app/App.tsx`
- Triggers: Browser GETs `/` or any SPA path mapped in `Bun.serve.routes`
- Responsibilities: Mount React tree, providers, router; render `LoginPage` until authenticated

**API mount point:**
- Location: `src/web/routes.ts`
- Triggers: Hono `app.fetch` invoked by Bun
- Responsibilities: Mount auth + trigger routes (no JWT), then 17 protected route modules behind `authMiddleware`

**CLI sync:**
- Location: `src/cli/sync.ts`
- Triggers: `docker exec wb-analytics-app bun run src/cli/sync.ts <command>`
- Responsibilities: Run an individual sync target (campaigns/products/orders/…) for ad-hoc remediation

**Multi-cabinet migration script:**
- Location: `src/cli/migrate-multi-cabinet.ts`
- Triggers: One-off manual run
- Responsibilities: Backfill `cabinet_id` on legacy single-tenant data

**Phone automation:**
- Location: `WBPartners-Auto/wb_order_monitor.py`
- Triggers: `wb-monitor.service` (systemd) running `venv/bin/python3 wb_order_monitor.py`
- Responsibilities: Drive the phone, populate `orders.db`, push notifications, fire bidberry trigger

**Phone server-only mode:**
- Location: `WBPartners-Auto/server.py`
- Triggers: Manual run on a host without the phone (fallback)
- Responsibilities: Run only the FastAPI + Telegram bot threads against an existing `orders.db`

## Architectural Constraints

- **Threading:** Bun runs the Hono server and scheduler on a single event-loop thread. All I/O is async. Long sync tasks call `Bun.sleep(ms)` between WB API batches (e.g. 500 ms) to back off. There is no worker_thread or cluster.
- **Process model:** Two cooperating processes on one host — Bun in `wb-analytics-app` Docker container (`docker-compose.yml:24-57`) and Python in systemd-supervised `wb-monitor.service`. They communicate by a read-only file (`./WBPartners-Auto/orders.db:/mnt/wbpartners/orders.db:ro`) and HTTP loopback.
- **Networking:** App container uses `network_mode: host` so it reaches the loopback Telegram proxy and a local MySQL on `127.0.0.1:3306`. Bun.serve binds to `127.0.0.1` only — public traffic must come through the host's reverse proxy.
- **Global state:** Module-level singletons exist for the MySQL pool (`src/db/connection.ts:4`), WB API client cache (`src/api/wb-client.ts:628`), scheduler tasks Map (`src/services/scheduler.ts:13`), and `clientInstance` legacy singleton (`src/api/wb-client.ts:651`). These are intentional and not reset across requests.
- **Multi-tenancy is convention, not isolation:** Every query must include `cabinet_id`; there is no row-level security in MySQL. Forgetting the filter leaks data across tenants.
- **Authoritative orders live outside the relational DB:** Cross-tenant code that needs orders must read both MySQL (`orders` table from WB API) and SQLite (`/mnt/wbpartners/orders.db`); only the latter is trusted for counts.
- **No build step for the SPA:** Bun's HTML imports compile `public/app/main.tsx` on the fly. Don't introduce Vite/webpack — it would break the `import index from '../public/index.html'` mechanism in `src/index.ts:1`.
- **Date discipline:** All bidberry datetime columns are MSK wall-clock (no TZ) to align with the phone DB's `date_parsed`. Code converting from UTC must add `MSK_OFFSET_HOURS = 3` (`src/services/cabinet-report.ts:18`).
- **Restart required for Python:** Any edit under `WBPartners-Auto/` requires `sudo systemctl restart wb-monitor.service`. Python is not hot-reloaded.

## Anti-Patterns

### Querying without `cabinet_id`

**What happens:** A repository function or ad-hoc SQL omits `WHERE cabinet_id = ?`, returning rows from every tenant.
**Why it's wrong:** Multi-tenant data leak; there is no MySQL-level guard. The convention is the only protection.
**Do this instead:** Take `cabinetId: number` as the first argument and put it in the `WHERE` clause. See every function in `src/db/repository.ts` (e.g. `getCampaigns(cabinetId)` at line 51) for the canonical shape.

### Trusting WB API for order counts

**What happens:** A new feature uses `wbClient.getOrders(...)` or the local `orders` MySQL table to display "today's orders" to the user.
**Why it's wrong:** WB Statistics API undercuts reality by ~14% and lags by minutes-to-hours; the SPA shows wrong numbers and CPS calculations get noisy.
**Do this instead:** For order *counts/lists* go through `getPhoneTotalsByArticle(fromIso, toIso)` in `src/services/wbpartners-phone-db.ts:50` (the read-only mount of `orders.db`). Use the WB API only for spend/budget/balance.

### Using a global `WBApiClient` in scheduler tasks

**What happens:** Code calls `getWBClient()` (the legacy env-key singleton at `src/api/wb-client.ts:651`) inside a per-cabinet loop.
**Why it's wrong:** All requests use one cabinet's API key; either authentication fails for the others or, worse, you write data attributed to the wrong cabinet.
**Do this instead:** Always go through `getWBClientForCabinet(cabinet.id, cabinet.wb_api_key)` (or the `wbClient` argument that `forEachCabinet` already passes you — `src/index.ts:50-56`).

### Talking to MySQL outside `forEachCabinet` for tenant data

**What happens:** A scheduler task uses `getActiveCabinets()` itself and forgets the per-cabinet error try/catch.
**Why it's wrong:** A single failing cabinet (bad API key, schema drift) aborts the whole task for everyone.
**Do this instead:** Wrap the body in `forEachCabinet('task-name', async (cabinetId, wbClient) => { ... })` so errors are logged per cabinet and the loop continues. See `src/index.ts:65-90` for the canonical pattern.

### Adding routes that bypass `authMiddleware`

**What happens:** A new sub-router is mounted before line 40 in `src/web/routes.ts`, or its prefix is added to the `if (...) return next()` allowlist.
**Why it's wrong:** Bypasses cabinet-access checks; any caller can read another tenant's data.
**Do this instead:** Mount under `app.route('/', xxxRoutes)` after `app.use('/api/*', ...)` in `src/web/routes.ts`. The only legitimate bypasses are `authRoutes` (login) and `triggerRoutes` (shared-secret webhook) — both already wired up.

## Error Handling

**Strategy:** Fail individual units, keep the system up. Errors are caught at the per-cabinet boundary (scheduler) or per-request boundary (Hono). Network/HTTP errors against WB API are retried with exponential backoff in `src/utils/retry.ts`.

**Patterns:**
- Routes return `c.json({ error: error.message }, 500)` (and `400`/`401`/`403` where appropriate) — see `src/web/orders-routes.ts` for the canonical shape.
- Scheduler tasks call `repo.updateImportRecord(importId, 'error', 0, error.message)` so failures show up in `imports` admin views; the per-task `forEachCabinet` then logs and continues to the next cabinet (`src/index.ts:58-60`).
- WB API errors are surfaced as `Error("WB API Error: <status> - <body>")` so `withRetry` can parse the status (`src/utils/retry.ts:19-27`); 400/401/403/404 are non-retryable, 429 honours `Retry-After`, 5xx use exponential backoff.
- The Python monitor escalates through tiers (`navigate_to_orders`, `handle_error_state`) and rate-limits "could not recover" Telegram alerts to avoid notification storms.

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` everywhere with `[Scheduler]`, `[startup]`, `[trigger]`, `[wbpartners-phone]`, `[WB API]`, `[retry]` prefixes. No structured logger; logs go to Docker stdout (`docker compose logs -f app`) or `journalctl -u wb-monitor.service`.

**Validation:** Inbound JSON validated with `@hono/zod-validator` and `zod` schemas at the route layer (e.g. `src/web/orders-routes.ts:9-14`). The phone DB applies SQL `CHECK` constraints (`WBPartners-Auto/db.py:18-35`).

**Authentication:** Telegram OAuth (`src/services/auth-service.ts:56-83`) → JWT with `userId`/`telegramId`/`role` claims, signed by `JWT_SECRET` (boot-time enforcement in `assertJwtSecretConfigured`, `src/services/auth-service.ts:43-53`). Cabinet access checked on every request (`src/web/auth-middleware.ts:28-50`). Admin role re-verified from DB on each admin request to defeat stale JWT claims (`auth-middleware.ts:66-76`). Webhook auth is a shared secret (`TRIGGER_SECRET`) compared with `crypto.timingSafeEqual` (`src/web/trigger-routes.ts:17-40`).

**Configuration:** Environment variables loaded by Bun automatically; required ones (`JWT_SECRET`, `TRIGGER_SECRET`, `MYSQL_*`, `TELEGRAM_*`) are listed in `docker-compose.yml:36-50`. Boot fails loud if `JWT_SECRET` is missing/weak.

**Background jobs:** All long-running work runs through `src/services/scheduler.ts`, never inline in a request handler — request handlers schedule background work via fire-and-forget (e.g. trigger webhook calls `sendCabinetReport(...).catch(...)` and returns 202).

---

*Architecture analysis: 2026-04-27*
