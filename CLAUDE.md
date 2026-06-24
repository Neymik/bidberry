# WB Analytics Dashboard

Multi-tenant SaaS platform for Wildberries e-commerce analytics. Manages advertising campaigns, product analytics, financial tracking, and order monitoring.

## Bun Runtime

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Stack & Architecture

- **Runtime**: Bun 1.3.6 + TypeScript (ESNext, react-jsx)
- **Backend**: Hono web framework (`src/web/routes.ts`), 17 scheduled sync tasks (`src/index.ts`)
- **Frontend**: React 19 SPA with HTML imports via `Bun.serve()` (no Vite/webpack)
- **Database**: MySQL 8.0 via mysql2/promise (no ORM)
- **Auth**: Telegram OAuth + JWT tokens
- **Multi-tenancy**: All data scoped by `cabinet_id`, each cabinet has its own WB API key

## Key Entry Points

- `src/index.ts` — Bun.serve + Hono API + scheduler (17 tasks)
- `src/api/wb-client.ts` — WB API client singleton with retry logic
- `src/db/connection.ts` — MySQL pool
- `src/services/scheduler.ts` — Task scheduling framework
- `src/cli/sync.ts` — Manual sync CLI
- `public/index.html` → `public/app/main.tsx` — React SPA entry

## Where work happens

**Claude Code now runs directly on `ostapLase` (the production server).** The working directory `/home/ostap/bidberry` IS production. There is no local Mac checkout anymore and no `ssh ostapLase` indirection — edits, builds, log checks, CLI syncs, and endpoint tests all happen in this shell against live code. Be careful: changes are immediately one `docker compose up -d --build` away from affecting the running stack.

Deploy workflow (in-place on this server):
```bash
cd ~/bidberry && docker compose up -d --build app
```

The WBPartners-Auto phone DB at `./WBPartners-Auto/orders.db` is bind-mounted into the app container (WBPartners-Auto lives inside this repo as of 2026-04-20).

## Multi-Developer Workflow — Dev Task Board (READ FIRST)

Multiple developers (and multiple Claude Code agents) share this one repo and one
MySQL on `ostapLase`. To work in parallel with **minimal communication**, all work
is coordinated through a shared **dev task board**. These rules are mandatory:

1. **Before building any new feature/change, check the task board first.**
   - Find whether the work already exists as a task and what its status is.
   - If it exists and is `in_progress` with another `assignee` → it's already taken;
     do not duplicate it. Coordinate via a task comment instead.
   - If it does not exist → create it before starting.
   - Check via CLI: `docker exec wb-analytics-app bun run src/cli/tasks.ts list`
     (or `show <id>`), or the UI at `http://localhost:${APP_PORT:-3000}/admin/tasks`.

2. **Claim before you touch code.** Set yourself as `assignee` and move the task to
   `in_progress` so no one else (human or agent) starts the same thing:
   `docker exec wb-analytics-app bun run src/cli/tasks.ts claim <id> <your-name>`.

3. **Always commit AND push the relevant files after finishing a feature.** Never
   leave completed work uncommitted in the shared working dir — others pull from
   `main`. Commit only files relevant to the task, write a clear message, `git push`,
   then mark the task **ИИ-готово**: `... tasks.ts done <id> <your-name>` (sets
   `ai_done`; add a `comment` if useful). **AI must NEVER set `resolved` (Решено)** —
   that status is human-only: a person verifies the work and sets Решено via the UI.

4. **Work directly on `main` — no per-task branches for now.** Everyone commits to
   the one repo on `main`; keep changes small and push straight to `main` so others
   pull them quickly. **Use a git worktree only when a change is big** (many files /
   many commits before it's coherent): `git worktree add ../bidberry-<name> <branch>`,
   do the work there, then **merge it back into `main` when done** and remove the
   worktree. Don't start a second large change while another's edits are uncommitted.

**Board internals:** DB tables `dev_tasks` + `dev_task_events` (global, NOT cabinet-scoped).
Repo `src/db/dev-tasks-repository.ts`, routes `src/web/dev-tasks-routes.ts`, CLI
`src/cli/tasks.ts`. Reads are open; the REST API mutations require header
`X-Trigger-Secret: $TRIGGER_SECRET` (the browser board prompts for it once via 🔑).
Statuses: `new` (Новое) → `in_progress` (В работе) → `ai_done` (ИИ-готово, set by AI)
→ `resolved` (Решено, **human-only**) ; `obsolete` (Неактуально). AI marks `ai_done`
on finishing; only a human sets `resolved` (the CLI rejects `status … resolved`).

CLI quick reference:
```bash
docker exec wb-analytics-app bun run src/cli/tasks.ts list [status]
docker exec wb-analytics-app bun run src/cli/tasks.ts add "Title" --desc "..." --priority high --tags "orders,api"
docker exec wb-analytics-app bun run src/cli/tasks.ts claim <id> <who>
docker exec wb-analytics-app bun run src/cli/tasks.ts status <id> <status> [who]
docker exec wb-analytics-app bun run src/cli/tasks.ts comment <id> "note" [who]
docker exec wb-analytics-app bun run src/cli/tasks.ts done <id> [who]
```

## Docker (on ostapLase)

- **Containers**: `wb-analytics-app` (Bun), `wb-analytics-mysql` (MySQL 8.0)
- **Ports**: App `127.0.0.1:${APP_PORT:-3000}`, MySQL `127.0.0.1:${MYSQL_PORT:-3306}`
- **Build & restart**: `docker compose up -d --build`
- **Logs**: `docker compose logs -f app`
- **CLI sync**: `docker exec wb-analytics-app bun run src/cli/sync.ts [command]`
- **DB reset**: `docker compose down -v && docker compose up -d mysql`
- App mounts Docker socket (`/var/run/docker.sock`) for emulator container management
- App also mounts WBPartners-Auto phone DB read-only: `./WBPartners-Auto/orders.db:/mnt/wbpartners/orders.db:ro`
- **Required env vars on `ostapLase` `~/bidberry/.env`** (deploy will fail loud if missing):
  - `JWT_SECRET` — long random string (`openssl rand -hex 32`). Used to sign session JWTs. App refuses to start if this is unset or equal to `change-me-in-production`.
  - `TRIGGER_SECRET` — long random string. Required header `X-Trigger-Secret` on `/api/trigger/*` webhooks. WBPartners-Auto must use the SAME value (see WBPartners-Auto/.env).

## Project Structure

```
src/
├── index.ts                    # Entry: Bun.serve + scheduler (17 tasks)
├── api/wb-client.ts            # WB API client (retry, batching, 7 API bases)
├── db/
│   ├── connection.ts           # MySQL pool
│   ├── repository.ts           # Campaigns, products, analytics
│   ├── cabinets-repository.ts  # Multi-tenant cabinets
│   ├── financial-repository.ts # PnL, sales reports, product costs
│   ├── monitoring-repository.ts# CPS/CPO, expenses, budget snapshots
│   ├── orders-repository.ts    # Orders
│   ├── search-repository.ts    # Search queries & clusters
│   └── ...                     # keywords, bidding, stock, traffic, promotions, emulator, events, users
├── services/
│   ├── scheduler.ts            # Task scheduling engine
│   ├── financial-sync.ts       # Expenses, payments, budgets
│   ├── financial-service.ts    # PnL calculation, unit economics
│   ├── search-analytics-service.ts # Search query & cluster sync
│   ├── smart-bidder.ts         # Automated bid adjustment
│   ├── keyword-tracker.ts      # SERP position monitoring
│   ├── orders-service.ts       # Order sync
│   ├── stock-service.ts        # Inventory sync
│   ├── emulator-orchestrator.ts# Redroid container lifecycle
│   └── docker-client.ts        # Docker Engine API client
├── web/
│   ├── routes.ts               # Main router (mounts all sub-routes)
│   ├── auth-middleware.ts      # JWT verification + cabinet context
│   ├── dashboard-routes.ts     # Dashboard summaries
│   ├── campaign-routes.ts      # Campaign CRUD & stats
│   ├── product-routes.ts       # Products & analytics
│   ├── financial-routes.ts     # PnL, unit economics
│   ├── monitoring-routes.ts    # CPS/CPO real-time metrics
│   ├── orders-routes.ts        # Order list & stats
│   ├── admin-routes.ts         # Admin panel (users, sync, imports)
│   ├── emulator-*-routes.ts    # Emulator provisioning & control
│   └── ...                     # stock, keyword, bidding, traffic, export, import, events, cabinet, auth
├── cli/
│   ├── sync.ts                 # Manual sync commands
│   └── migrate-multi-cabinet.ts# Multi-cabinet migration
├── excel/
│   ├── report-generator.ts     # 7-sheet "Перечень информации" report
│   ├── exporter.ts / importer.ts # Excel I/O
│   └── report-generator.test.ts
├── utils/
│   ├── retry.ts                # Exponential backoff for WB API
│   └── report-fetcher.ts       # Async WB CSV report utility
└── types/index.ts              # All TypeScript interfaces

public/app/
├── App.tsx                     # React router (10 pages)
├── hooks/                      # useAuth, useCabinet, useDateRange, useApi, useToast
└── components/                 # dashboard, campaigns, products, financial, monitoring, admin, emulator, keywords, import-export
```

## Scheduler Tasks (17 total)

All run per-cabinet with error isolation. Defined in `src/index.ts`.

| Task | Interval | Description |
|------|----------|-------------|
| keyword-positions | 6h | SERP rankings |
| sales-sync | 12h | Revenue & returns (7 days) |
| smart-bidder | 30m | Auto-adjust bids |
| campaigns-sync | 6h | Campaign list |
| campaign-stats-sync | 6h | Campaign metrics (7 days) |
| products-sync | 12h | Product catalog (paginated) |
| product-analytics-sync | 12h | Product funnel (batch 20) |
| traffic-sources-sync | 12h | Traffic breakdown |
| prices-sync | 24h | Prices & discounts |
| promotions-sync | 24h | Promo participation |
| campaign-products-sync | 12h | Campaign-product mapping |
| orders-sync | 6h | Orders full sync (30 days) |
| orders-sync-fast | 15m | Orders fast sync (yesterday+today) |
| product-analytics-sync-fast | 2h | Today's analytics (scaling factor) |
| stocks-sync | 12h | Inventory levels |
| search-queries-sync | 24h | Search text analytics |
| cluster-stats-sync | 24h | Cluster performance |
| financial-sync | 15m | Expenses, payments, budgets |
| cabinet-report | 15m | Telegram per-product orders/spend/CPO digest |
| cpo-guard | 15m | Alert-only: Telegram warning when a product's today CPO is out of line (≥3× cabinet blended CPO or > absolute ceiling), active hours only, with breach streak + re-alert cooldown. Env knobs `CPO_GUARD_*`. First milestone of realtime CPO control (later: auto bid-down, auto-pause) |
| penalty-guard | 6h | Alert-only: warehouse penalties & dimension re-measures (перемер/занижение габаритов) from WB's financial detail report (`reportDetailByPeriod` — the only source). Stores every penalty/габарит line in `warehouse_penalties` (deduped by `rrd_id`); alerts once per (product × reason) group the first time it appears. WEEKLY/lagged source, not realtime; phone can't see these. Env knobs `PENALTY_GUARD_*`. Seed baseline silently before first run to avoid backlog dump |
| emulator-health-check | 60s | Container health |

## Monitoring (CPS/CPO Real-Time)

- **Purpose**: real-time CPS spike detection — react quickly to pause campaigns when CPS jumps
- **Orders**: `orders-sync-fast` every 15min (dateFrom=yesterday), full sync every 6h
- **Spend**: budget snapshots every 15min (financial-sync)
- **Order Scale**: user-configurable per product (like buyout %). Auto-calculated from Analytics/Statistics API ratio (~115-125%). Manual override available. `NULL` = auto mode
- **WB API gap**: Statistics API returns ~75-85% of real orders. Analytics API gives accurate daily count but no hourly breakdown. Scale factor compensates for this
- **Frontend**: auto-refreshes every 2min, triggers on-demand fast orders sync on page open

## APIs

- `Bun.serve()` with Hono. Don't use `express`.
- `mysql2/promise` for MySQL. No ORM.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile.

## Testing

Use `bun test` to run tests. Tests are co-located with source (`.test.ts` files).

## Frontend

React 19 SPA with HTML imports via `Bun.serve()`. Don't use Vite.
- Entry: `public/index.html` imports `public/app/main.tsx`
- Styling: Tailwind CSS + Chart.js for charts
- State: Custom hooks (`useAuth`, `useCabinet`, `useDateRange`, `useApi`, `useToast`)
- Pages: Dashboard, Campaigns, Products, Keywords, Financial, Import/Export, Monitoring, Penalties (Штрафы), Emulator, Admin
- New SPA route checklist: add to `App.tsx` (import + `<Route>`), `AppSidebar.tsx` (`navItems`), AND `src/index.ts` `Bun.serve({ routes })` — the last one is required or the deep link 401s instead of serving the SPA

## WBPartners-Auto (Order Monitor)

Subdirectory `WBPartners-Auto/` — Python-based WB Partners mobile app automation.

- **Purpose**: Monitors WB Partners Android app order feed via uiautomator2, stores orders in SQLite, exposes Telegram bot + FastAPI REST API
- **Stack**: Python + uiautomator2 + FastAPI + Telegram bot
- **Primary mode**: Physical Huawei device connected to `ostapLase` via USB/ADB — this is the main way it runs. Docker/Redroid emulator is a fallback only.
- **Entry points**: `wb_order_monitor.py` (full automation), `server.py` (API+bot only)
- **Supervised by systemd**: `wb-monitor.service` on `ostapLase` — runs `/home/ostap/bidberry/WBPartners-Auto/venv/bin/python3 wb_order_monitor.py`. **After any code change under `./WBPartners-Auto/` (bot.py, wb_order_monitor.py, db.py, server.py, …) restart the service or the changes don't take effect — Python does not hot-reload:**
  ```bash
  sudo systemctl restart wb-monitor.service
  sudo journalctl -u wb-monitor.service -f     # tail logs
  ```
- **Check device**: `adb devices` — if empty, the phone is disconnected or ADB is down
- **Fallback (Docker)**: Redroid (Android 11, API 30) emulator + ws-scrcpy web UI
- **Docker commands** (fallback only):
  - Start: `cd WBPartners-Auto && docker compose up -d`
  - Logs: `docker logs redroid`
  - ADB shell: `adb connect localhost:5555 && adb shell`
- **Run monitor**: `python WBPartners-Auto/wb_order_monitor.py`
- **Status transitions** (Заказ→Отказ/Выкуп/Возврат): the monitor runs three
  jobs through one in-process orchestrator — regular cycle (~3min), shallow
  rescan (hourly, 24h lookback), deep rescan (daily, 72h lookback). Status
  changes flow into `orders.status` and per-cycle Telegram alerts. Bidberry's
  `getPhoneTotalsByArticle` (in `src/services/wbpartners-phone-db.ts`) counts
  only currently-active orders (`status IN ('Заказ','Выкуп')`); cancellations
  and returns are excluded so CPO and /count totals reflect orders that still
  contribute revenue. See `WBPartners-Auto/CLAUDE.md` for the full design.
- **First deploy of status tracking:** set `RESCAN_INITIAL_SILENT=1` in the env
  before the first `systemctl restart` to suppress Telegram alerts during the
  catch-up reconcile, then drop the env var on the next restart.

## Wildberries API Notes

- **WB API is unreliable for order data** — it lags (propagation delays from minutes to hours), undercounts (~14% missing vs reality), sometimes returns stale or inconsistent results, and endpoints occasionally break or behave unexpectedly. DO NOT treat WB API order data as authoritative.
- **Phone scraping (WBPartners-Auto) is the authoritative source for orders** — the Huawei device running the WB Partners Android app sees what the seller actually sees and captures orders in near-realtime. When WB API and phone disagree, trust the phone.
- WB API IS the only source for data the phone can't observe: ad spend, campaign budgets, CPM bids, balance — use it for those, with the caveats below.
- WB API is known to be buggy: random 500s, timeouts, rate limits, inconsistent responses
- Always use retry logic with exponential backoff when calling WB API (`src/utils/retry.ts`)
- Batch WB API calls (max 20 nmIds per request) and add delays between batches
- Sync endpoints should isolate errors per-item — one failure shouldn't stop the whole sync
- WB frequently deprecates/moves endpoints without notice — check memory for endpoint history
- CLI sync: `docker exec wb-analytics-app bun run src/cli/sync.ts [command]`
- Available sync commands: campaigns, products, prices, promotions, campaign-products, keywords, analytics, traffic, orders, stocks, search

## Key Patterns

- **Multi-tenancy**: All queries scoped by `cabinet_id`. JWT includes cabinetId. `forEachCabinet()` in scheduler.
- **Data preservation**: Never delete data — archive to `old_` tables if cleanup needed.
- **Import tracking**: All syncs logged via `repo.createImportRecord()` / `repo.updateImportRecord()`.
- **After code changes**: Always `docker compose up -d --build` before running CLI.
- **Rate limits**: Search analytics 3 req/min; cluster stats 10 req/min; campaign products 300ms delay; general 500ms between batches.
