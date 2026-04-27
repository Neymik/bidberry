---
title: Codebase Structure
date: 2026-04-27
focus: arch
---

# Codebase Structure

## Directory layout (top level + key subtrees)

```
bidberry/
├── src/                     # TypeScript backend (Bun + Hono)
│   ├── index.ts             # Bun.serve + Hono + 19 scheduler tasks
│   ├── api/                 # wb-client.ts (7 WB hosts, per-cabinet cache) + test
│   ├── db/                  # mysql2 pool + 14 *-repository.ts modules (no ORM)
│   ├── services/            # scheduler, sync services, auth, cabinet-report, phone-db reader, emulator orchestration
│   ├── web/                 # routes.ts (mount table) + auth-middleware + cabinet-context + 17 *-routes.ts + tests
│   ├── cli/                 # sync.ts, migrate-multi-cabinet.ts
│   ├── excel/               # exporter / importer / report-generator + test
│   ├── utils/               # retry.ts, report-fetcher.ts
│   └── types/index.ts       # all TS interfaces
├── public/                  # SPA served via Bun HTML imports
│   ├── index.html           # entry; loads ./app/main.tsx as ESM
│   └── app/
│       ├── main.tsx         # createRoot + BrowserRouter
│       ├── App.tsx          # auth gate, providers, 9 routes
│       ├── hooks/           # useApi, useAuth, useCabinet, useDateRange, useToast
│       ├── styles/globals.css
│       └── components/      # layout, auth, dashboard, campaigns, products, keywords, financial, monitoring, import-export, emulator, admin
├── WBPartners-Auto/         # Python sidecar (systemd-supervised)
│   ├── wb_order_monitor.py  # uiautomator2 → SQLite → Telegram → bidberry trigger
│   ├── server.py            # API+bot only fallback
│   ├── db.py                # SQLite schema (DELETE journal mode for bind-mount visibility)
│   ├── api.py               # FastAPI on :22001
│   ├── bot.py               # python-telegram-bot
│   ├── migrate*.py, recount_today.py, cleanup_empty_wh.py
│   ├── orders.db            # AUTHORITATIVE order store; bind-mounted RO into app container
│   ├── orders.db.pre-*      # manual pre-migration backups
│   ├── venv/, requirements.txt, ws-scrcpy-config.yaml, monitor.log
│   ├── docker-compose.yml   # Redroid + scrcpy fallback
│   ├── CLAUDE.md, DEPLOY.md
├── docker/
│   ├── init.sql             # MySQL bootstrap, runs only on empty volume
│   └── wb-monitor/          # per-cabinet emulator monitor image (Dockerfile, parser.py, run.py)
├── scripts/backup/          # backup.sh / prune.sh / restore.sh + systemd .service/.timer
├── tests/emu-proxy-diag.ts  # most tests are co-located *.test.ts
├── docs/                    # reports-data-dictionary.md, superpowers/
├── exports/                 # generated XLSX (mounted at /app/exports)
├── .planning/codebase/      # GSD workflow output (this analysis)
├── docker-compose.yml       # mysql + app (host network, RO sqlite mount)
├── Dockerfile               # oven/bun:1.3.6-slim → bun run src/index.ts
├── package.json, bun.lock, tsconfig.json
├── README.md, CLAUDE.md
└── .env, .env.example
```

## Directory purposes

- `src/api/` — external API clients. Single `WBApiClient` covering 7 WB hostnames; per-cabinet cache.
- `src/db/` — pool + repositories. Every function takes `cabinetId` first; no ORM.
- `src/services/` — domain logic, scheduler engine, integrations. Notable: `cabinet-report.ts`, `wbpartners-phone-db.ts`, `emulator-orchestrator.ts`, `docker-client.ts`.
- `src/web/` — Hono apps + middleware. `routes.ts` mounts all sub-apps; `auth-middleware.ts` is the JWT/cabinet fence; `cabinet-context.ts` exposes per-request helpers; `trigger-routes.ts` is the shared-secret webhook surface.
- `src/cli/` — operator commands run inside the container.
- `src/excel/` — XLSX import/export + 7-sheet "Перечень информации" report generator.
- `src/utils/` — `retry.ts` (exp backoff with `Retry-After`), `report-fetcher.ts` (async WB CSV polling).
- `src/types/index.ts` — all TS interfaces in one file (DB rows + WB API DTOs).
- `public/app/` — React 19 SPA. Hooks-based state; one folder per page under `components/`.
- `WBPartners-Auto/` — Python phone scraper. Authoritative order source. Restart `wb-monitor.service` after any change.
- `docker/` — Bidberry-side Docker assets (`init.sql`, `wb-monitor/` image).
- `scripts/backup/` — Daily S3 GPG-encrypted backups via systemd timer.
- `exports/` — runtime-generated XLSX files.

## Key file locations

- **Entry points:** `src/index.ts`; `public/index.html` → `public/app/main.tsx` → `public/app/App.tsx`; `src/cli/sync.ts`; `WBPartners-Auto/wb_order_monitor.py`; `WBPartners-Auto/server.py`.
- **Configuration:** `package.json`, `tsconfig.json` (ESNext + `react-jsx` + strict + bundler resolution), `Dockerfile` (`oven/bun:1.3.6-slim`), `docker-compose.yml` (host network + RO sqlite mount + Docker socket mount), `docker/init.sql`, `.env`, `WBPartners-Auto/.env`, `WBPartners-Auto/requirements.txt`.
- **Core logic:** `src/web/routes.ts`, `src/web/auth-middleware.ts`, `src/web/cabinet-context.ts`, `src/services/scheduler.ts`, `src/api/wb-client.ts`, `src/db/connection.ts`, `src/services/cabinet-report.ts`, `src/services/wbpartners-phone-db.ts`.
- **Frontend core:** `public/app/App.tsx`, `public/app/hooks/useApi.ts`, `public/app/hooks/useCabinet.tsx`.
- **Co-located tests:** `src/api/wb-client.test.ts`, `src/web/auth-middleware.test.ts`, `src/web/cabinet-context.test.ts`, `src/web/cabinet-routes.test.ts`, `src/web/admin-routes.test.ts`, `src/web/trigger-routes.test.ts`, `src/services/auth-service.test.ts`, `src/services/cabinet-report.test.ts`, `src/excel/report-generator.test.ts`. Out-of-tree: `tests/emu-proxy-diag.ts`.

## Naming conventions

- **Files:** kebab-case for backend modules (`cabinet-report.ts`, `wbpartners-phone-db.ts`); `<domain>-routes.ts` for Hono apps; `<domain>-repository.ts` for repos; `<domain>-service.ts` for services; tests are `<file>.test.ts` co-located.
- **React:** `PascalCase.tsx` for components; `useXxx.ts(x)` for hooks (`.tsx` only when JSX is returned).
- **Python:** snake_case (`wb_order_monitor.py`, `recount_today.py`).
- **Directories:** lowercase short names under `src/`; per-feature lowercase folders under `public/app/components/`; `WBPartners-Auto/` keeps mixed case for historical reasons — don't rename.

## Where to add new code

- **New API endpoint** → add to (or create) `src/web/<domain>-routes.ts`, mount in `src/web/routes.ts` after `app.use('/api/*', ...)`. Use `getCabinetId(c)` / `getWBClientFromContext(c)`. Validate with `zod` + `@hono/zod-validator`.
- **New scheduled sync** → service function in `src/services/<domain>-service.ts`, then `scheduler.registerTask(...)` at the bottom of `src/index.ts`, body wrapped in `forEachCabinet(...)` and bracketed by `repo.createImportRecord` / `updateImportRecord`.
- **New table** → `CREATE TABLE` in `docker/init.sql` + idempotent migration called from startup in `src/index.ts` (pattern: `migrateAllowedUsersAddTelegramId` in `src/db/cabinets-repository.ts`); add a `*-repository.ts` and types in `src/types/index.ts`.
- **New WB API call** → method on `WBApiClient` in `src/api/wb-client.ts` using the right base URL constant; insert `Bun.sleep` between batches.
- **New SPA page** → `public/app/components/<feature>/<Feature>Page.tsx`; add `<Route>` in `public/app/App.tsx`, link in `AppSidebar.tsx`, and add the URL to `Bun.serve.routes` in `src/index.ts`.
- **New webhook** → inside `src/web/trigger-routes.ts` so it inherits `requireTriggerSecret`. Don't extend the `if (...) return next()` allowlist in `routes.ts`.
- **New phone-DB read** → extend `src/services/wbpartners-phone-db.ts`. Never write — bind mount is read-only and Python is the single writer.
- **New Python feature** → modify under `WBPartners-Auto/`; schema changes via the `SCHEMA` string + idempotent migration in `db.py`'s `init_db`. Then `sudo systemctl restart wb-monitor.service` (mandatory — no hot reload).
- **New CLI command** → add a dispatch case in `src/cli/sync.ts`.
- **Background work on request** → fire-and-forget then 202 (pattern in `src/web/trigger-routes.ts:50-61`).
- **New helper** → pure utility in `src/utils/`; stateful in `src/services/`; React in `public/app/hooks/`.

## Special directories

- `exports/` — runtime-generated XLSX, gitignored, mounted at `/app/exports`.
- `WBPartners-Auto/venv/` — Python virtualenv used by `wb-monitor.service`. Not committed.
- `WBPartners-Auto/orders.db` — authoritative phone-scraped order DB. Bind-mounted **read-only** into bidberry at `/mnt/wbpartners/orders.db` (see `docker-compose.yml:57`). Uses DELETE journal mode so every commit is visible to the bind mount (no -wal/-shm files).
- `WBPartners-Auto/orders.db.pre-*` — pre-migration safety backups; currently untracked.
- `.planning/` — GSD workflow scratch.
- `docker/init.sql` — runs only on a fresh MySQL volume; to re-bootstrap, `docker compose down -v && docker compose up -d mysql`.
- Mounted host paths used at runtime: `/var/run/docker.sock` (used by `docker-client.ts` + `emulator-orchestrator.ts` — privileged), `/etc/nginx/conf.d` and `/etc/wb-emulators` (emulator orchestrator writes vhost configs; reload trigger file is `/etc/nginx-conf/.reload-trigger`).
