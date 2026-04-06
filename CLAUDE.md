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

## Docker

- **Containers**: `wb-analytics-app` (Bun), `wb-analytics-mysql` (MySQL 8.0)
- **Ports**: App `127.0.0.1:${APP_PORT:-3000}`, MySQL `127.0.0.1:${MYSQL_PORT:-3306}`
- **Build & restart**: `docker compose up -d --build`
- **Logs**: `docker compose logs -f app`
- **CLI sync**: `docker exec wb-analytics-app bun run src/cli/sync.ts [command]`
- **DB reset**: `docker compose down -v && docker compose up -d mysql`
- App mounts Docker socket (`/var/run/docker.sock`) for emulator container management

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
├── App.tsx                     # React router (9 pages)
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
- Pages: Dashboard, Campaigns, Products, Keywords, Financial, Import/Export, Monitoring, Emulator, Admin

## WBPartners-Auto (Order Monitor)

Subdirectory `WBPartners-Auto/` — Python-based WB Partners mobile app automation.

- **Purpose**: Monitors WB Partners Android app order feed via uiautomator2, stores orders in SQLite, exposes Telegram bot + FastAPI REST API
- **Stack**: Python + uiautomator2 + FastAPI + Telegram bot
- **Docker**: Redroid (Android 11, API 30) emulator + ws-scrcpy web UI
- **Entry points**: `wb_order_monitor.py` (full automation), `server.py` (API+bot only)
- **Ports**: ADB `127.0.0.1:5555`, API `22001`, ws-scrcpy `22090`
- **Docker commands**:
  - Start: `cd WBPartners-Auto && docker compose up -d`
  - Logs: `docker logs redroid`
  - ADB shell: `adb connect localhost:5555 && adb shell`
  - Run monitor: `python WBPartners-Auto/wb_order_monitor.py`

## Wildberries API Notes

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
