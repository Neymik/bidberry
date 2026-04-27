# Technology Stack

**Analysis Date:** 2026-04-27

## Languages

**Primary:**
- TypeScript (ESNext, strict mode) — main app: `src/**/*.ts`, `public/app/**/*.tsx`
- Python 3 — phone-scraping subsystem: `WBPartners-Auto/*.py`

**Secondary:**
- Bash — backup tooling and ops scripts: `scripts/backup/backup.sh`, `scripts/backup/prune.sh`, `scripts/backup/restore.sh`
- SQL — MySQL bootstrap schema: `docker/init.sql`; SQLite schema embedded in `WBPartners-Auto/db.py`

## Runtime

**Environment:**
- Bun 1.3.6 — runs the main app, scheduler, CLI, tests. Pinned via Docker base image `oven/bun:1.3.6-slim` in `Dockerfile:1`. Bun auto-loads `.env` (no dotenv used in TS code).
- Python 3.12-slim — Redroid emulator monitor sidecar image: `docker/wb-monitor/Dockerfile`
- Python 3 (system, via venv) — supervised on host by systemd: `WBPartners-Auto/venv/bin/python3 wb_order_monitor.py` per `WBPartners-Auto/CLAUDE.md`
- Node-style globals (`process.env`) used throughout — Bun-compatible.

**Package Manager:**
- bun — for the TypeScript app
- Lockfile: `bun.lock` present (lockfileVersion 1, configVersion 1)
- pip — for `WBPartners-Auto/requirements.txt`. No lockfile (no `requirements.lock` / `pip-tools` output).

## Frameworks

**Core:**
- Hono 4.11.5 — HTTP router, mounted on `Bun.serve()` — `src/web/routes.ts`, `src/index.ts:586-603`
- React 19.2.4 — frontend SPA — `public/app/main.tsx`, `public/app/App.tsx`
- react-dom 19.2.4 — `public/app/main.tsx:2`
- react-router-dom 7.13.0 — client-side routing — `public/app/main.tsx:3`
- FastAPI (Python) — private REST API for phone-scrape data — `WBPartners-Auto/api.py:13`
- python-telegram-bot[socks] — Telegram bot for `/orders`, `/count`, `/stats` etc. — `WBPartners-Auto/bot.py:11`
- uiautomator2 — Android UI automation against the Huawei phone / Redroid — `WBPartners-Auto/wb_order_monitor.py:7`
- uvicorn[standard] — ASGI server for FastAPI — `WBPartners-Auto/api.py:11`, `WBPartners-Auto/api.py:177`

**Testing:**
- `bun:test` (built-in) — co-located `*.test.ts` files use `import { test, expect, describe, mock, beforeEach } from 'bun:test'`. Examples: `src/web/trigger-routes.test.ts`, `src/services/auth-service.test.ts`, `src/services/cabinet-report.test.ts`, `src/excel/report-generator.test.ts`
- Python `unittest` — `WBPartners-Auto/test_build_key.py`

**Build/Dev:**
- No bundler. `Bun.serve()` consumes HTML imports directly: `src/index.ts:1` does `import index from '../public/index.html';`. Tailwind and Chart.js are loaded from CDNs in `public/index.html:9-10`.
- `bun run --watch src/index.ts` for dev (`package.json:8`).
- TypeScript compiler used only for type checking (`noEmit: true` in `tsconfig.json:15`).

## Key Dependencies

**Critical (TypeScript app, `package.json:25-37`):**
- `hono` ^4.11.5 — web framework
- `@hono/zod-validator` ^0.7.6 — request validation middleware (used in `src/web/product-routes.ts`, `src/web/orders-routes.ts`, `src/web/financial-routes.ts`, `src/web/keyword-routes.ts`, `src/web/bidding-routes.ts`, `src/web/import-routes.ts`)
- `zod` ^4.3.6 — schema validation
- `mysql2` ^3.16.1 — MySQL driver, used as `mysql2/promise` — `src/db/connection.ts:1`
- `jsonwebtoken` ^9.0.3 — JWT signing & verification — `src/services/auth-service.ts:2`
- `dayjs` ^1.11.19 — date manipulation everywhere (timezone math for MSK, scheduler windows)
- `xlsx` ^0.18.5 — Excel I/O for reports — `src/excel/exporter.ts:1`, `src/excel/importer.ts`, `src/excel/report-generator.ts`
- `fflate` ^0.8.2 — zip/gzip helpers (used by xlsx, report-fetcher)
- `react` ^19.2.4 / `react-dom` ^19.2.4 / `react-router-dom` ^7.13.0 — frontend SPA

**Critical (Python, `WBPartners-Auto/requirements.txt`):**
- `uiautomator2` — drives the WB Partners Android app via ADB
- `python-telegram-bot[socks]` — Telegram bot framework with SOCKS proxy support
- `python-dotenv` — `.env` loader (Python doesn't get Bun's auto-load)
- `requests` — HTTP client (used to call `https://api.telegram.org` and the bidberry trigger webhook)
- `Pillow` — image handling for OCR fallback path
- `fastapi` + `uvicorn[standard]` — private REST API exposing the SQLite order DB
- `sqlite3` (stdlib) — direct SQLite access — `WBPartners-Auto/db.py:3`

**Built-in / runtime modules:**
- `bun:sqlite` — read-only access to phone DB from main app — `src/services/wbpartners-phone-db.ts:20`
- `node:crypto` — `timingSafeEqual`, `createHmac`, `createHash` for Telegram-auth HMAC and trigger-secret comparison — `src/services/auth-service.ts:1`, `src/web/trigger-routes.ts:12`
- `node:fs/promises` — emulator orchestrator file ops — `src/services/emulator-orchestrator.ts:344,488`

**Infrastructure:**
- Docker Engine (host socket mounted) — managed via raw HTTP to `/var/run/docker.sock` — `src/services/docker-client.ts:6`
- nginx (host) — reverse-proxies emulator ws-scrcpy URLs; config dir bind-mounted at `/etc/nginx-conf` — `src/services/emulator-orchestrator.ts:24`
- systemd — supervises `wb-monitor.service` and `bidberry-backup.timer/.service` (units in `scripts/backup/systemd/`)
- ADB / `android-tools-adb` — installed in `docker/wb-monitor/Dockerfile:4`
- aws CLI v2, gpg, sqlite3 CLI — required on host by `scripts/backup/backup.sh:74-77` (sanity-check fail-fast)

## Configuration

**Environment:**
- Bun auto-loads `.env` for the main app (no `dotenv` package). `python-dotenv` is used in `WBPartners-Auto/*.py` (e.g. `WBPartners-Auto/api.py:12`, `WBPartners-Auto/wb_order_monitor.py:14`).
- Two separate `.env` files: `/home/ostap/bidberry/.env` (app) and `/home/ostap/bidberry/WBPartners-Auto/.env` (phone monitor). Both must agree on `TRIGGER_SECRET` — see `CLAUDE.md` "Required env vars" section.
- A third env file for backups lives at `/etc/bidberry-backup.env` (root:root 600), loaded via `EnvironmentFile=` in `scripts/backup/systemd/bidberry-backup.service`.
- Examples: `.env.example` (app — 12 vars) and `WBPartners-Auto/.env.example` (4 vars).

**Key configs required (app — see `docker-compose.yml:36-50`):**
- `WB_API_KEY` (legacy global; per-cabinet keys live in DB column `cabinets.wb_api_key`)
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`
- `APP_PORT` (default 3000)
- `JWT_SECRET` — fail-loud at boot if unset / `change-me-in-production` / `<32 chars` (`src/services/auth-service.ts:43-53`)
- `JWT_ACCESS_TTL` (default `24h`)
- `TRIGGER_SECRET` — must match WBPartners-Auto's value; checked constant-time in `src/web/trigger-routes.ts:29-40`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME`, `TELEGRAM_CHAT_ID`, `TELEGRAM_PROXY_URL` (optional)
- `WBPARTNERS_DB_PATH` (default `/mnt/wbpartners/orders.db`) — `src/services/wbpartners-phone-db.ts:22`
- `EXPORTS_DIR` (default `./exports`) — `src/excel/exporter.ts:13`, `src/excel/report-generator.ts:11`
- `NODE_ENV` — gates JWT enforcement, scheduler start, and `Bun.serve` development mode

**Key configs required (WBPartners-Auto):**
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `API_KEY`, `API_HOST` (default `0.0.0.0`), `API_PORT` (default `22001`) — `WBPartners-Auto/api.py:28-30`
- `BIDBERRY_URL` (default `http://127.0.0.1:3000`), `BIDBERRY_CABINET_ID`, `TRIGGER_SECRET` — used to call back into the main app's `/api/trigger/cabinet-report/:cabinetId` (`WBPartners-Auto/wb_order_monitor.py:60-72`, `WBPartners-Auto/bot.py:198-206`)
- `ALL_PROXY` / `all_proxy` (SOCKS proxy for Telegram in RU) — `WBPartners-Auto/wb_order_monitor.py:27-31`

**Build:**
- `Dockerfile` — single-stage Bun image (`oven/bun:1.3.6-slim`), `bun install --frozen-lockfile`, exposes port 3000.
- `docker/wb-monitor/Dockerfile` — Python 3.12 + uiautomator2 + adb image for the in-Docker emulator monitor sidecar.
- `WBPartners-Auto/docker-compose.yml` — Redroid 14 + ws-scrcpy fallback (primary mode is physical Huawei via ADB).
- `tsconfig.json` — `target: ESNext`, `module: Preserve`, `jsx: react-jsx`, `moduleResolution: bundler`, `strict: true`, `noEmit: true`.

## Platform Requirements

**Development:**
- Bun ≥ 1.3.6 + Docker + Docker Compose. The repo's working directory is the production server (`ostapLase`); there is no separate Mac checkout. See `CLAUDE.md` "Where work happens" section.

**Production:**
- Single host (`ostapLase`) running Linux 6.17 (`uname -r` reports `6.17.0-20-generic`).
- Two stateful Docker containers: `wb-analytics-app` (Bun, host network), `wb-analytics-mysql` (MySQL 8.0, port 127.0.0.1:3306). Defined in `docker-compose.yml`.
- Per-cabinet emulator stacks: `wb-emu-redroid-<id>`, `wb-emu-scrcpy-<id>`, `wb-emu-monitor-<id>` — provisioned dynamically via `src/services/emulator-orchestrator.ts`.
- Host nginx reverse-proxies `/emu/<id>/...` paths to each cabinet's ws-scrcpy container; config files live at `/etc/nginx-conf/wb-emulators.conf` and are written by the orchestrator.
- Host systemd: `wb-monitor.service` (phone scraper), `bidberry-backup.timer` + `bidberry-backup.service` (daily 04:00 MSK S3 backup).
- Physical Huawei Android device connected via USB/ADB on the host (primary order source). Redroid container is a fallback only.
- Host packages: `aws` CLI v2, `sqlite3`, `gpg`, `docker` (required by backup; sanity-checked in `scripts/backup/backup.sh:74-80`).

---

*Stack analysis: 2026-04-27*
