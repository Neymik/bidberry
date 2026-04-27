# External Integrations

**Analysis Date:** 2026-04-27

## APIs & External Services

**Wildberries (the core integration — 7 distinct API base URLs, all defined in `src/api/wb-client.ts:14-20`):**

- `https://advert-api.wildberries.ru` — campaigns, bids, balance, budget, expense (UPD) and payment history, search-cluster stats. Used by `getCampaigns`, `getCampaignsInfo`, `getCampaignStats` (v3), `getBids`, `setBid`, `getAutoBids`, `getBalance`, `getCampaignBudget`, `setCampaignBudget`, `getExpenseHistory`, `getPaymentsHistory`, `getKeywordStats`, `getRecommendedKeywords`, `getSearchClusterStatsBatch` — `src/api/wb-client.ts:67-538`.
- `https://seller-analytics-api.wildberries.ru` — v3 sales-funnel product analytics, search-report queries, async report fetching. `getProductAnalytics`, `getProductAnalyticsDetailed`, `getSalesHistory`, `getSearchTexts`, `getSearchReport` — `src/api/wb-client.ts:234-590`. Also used by `src/utils/report-fetcher.ts` (async CSV reports).
- `https://content-api.wildberries.ru` — product card catalog (paginated cursor). `getProducts`, `getProductInfo` — `src/api/wb-client.ts:319-356`.
- `https://statistics-api.wildberries.ru` — `getSalesReport` (`/api/v1/supplier/sales`), `getOrders` (`/api/v1/supplier/orders`), `getStocks` (`/api/v1/supplier/stocks`) — `src/api/wb-client.ts:308-397`.
- `https://discounts-prices-api.wildberries.ru` — `getPrices` (`/api/v2/list/goods/filter`) — `src/api/wb-client.ts:481-488`.
- `https://dp-calendar-api.wildberries.ru` — `getPromotions`, `getPromotionNomenclatures` — `src/api/wb-client.ts:493-519`.
- `https://advert-media-api.wildberries.ru` — declared (`src/api/wb-client.ts:20`) but not yet called by any method.
- Auth: `Authorization: <token>` header (no `Bearer` prefix). Per-cabinet keys live in MySQL column `cabinets.wb_api_key`; client cache keyed by `cabinetId` in `src/api/wb-client.ts:628-641`. Legacy global `process.env.WB_API_KEY` only used when no per-cabinet key is supplied.
- All requests wrapped in `withRetry` from `src/utils/retry.ts` — exponential backoff, 60s `AbortSignal.timeout`, special-cases `Retry-After` for 429s, refuses to retry 400/401/403/404.

**Telegram:**

- `https://api.telegram.org` — bot Web API.
- Outgoing notifications from main app: `src/services/telegram-notifier.ts:12-49` (`sendMessage`, supports `TELEGRAM_PROXY_URL` for in-RU deployment).
- Outgoing notifications from phone monitor: `WBPartners-Auto/wb_order_monitor.py:75-138` — bounded retry budget (`TG_MAX_ATTEMPTS=4`, `TG_TOTAL_BUDGET_SEC=120`); failures persist to a SQLite `pending_telegram` queue (`WBPartners-Auto/db.py:42-50`) and flush at the next monitor cycle (`flush_pending_telegram` in `wb_order_monitor.py:154-175`).
- Incoming: Telegram bot polling drives `WBPartners-Auto/bot.py` (commands `/orders`, `/count`, `/status`, `/stats`, `/csv`, `/help`); SOCKS proxy supported via `python-telegram-bot[socks]` + `ALL_PROXY` env (`wb_order_monitor.py:27-31`).
- Telegram OAuth (Login Widget) used as the **only** sign-in method — see "Authentication & Identity" below.
- Auth: bot token in `TELEGRAM_BOT_TOKEN`. Bot username advertised to frontend at `GET /api/auth/config` — `src/web/auth-routes.ts:10-14`.

**Wildberries Partners Mobile App (Android):**

- Not an API — automated via UI scraping with uiautomator2 over ADB — `WBPartners-Auto/wb_order_monitor.py`.
- Primary device: Huawei phone connected via USB to `ostapLase`. Fallback: Redroid 14 container in `WBPartners-Auto/docker-compose.yml`.
- Authoritative source for **order data** (per `CLAUDE.md`: WB API undercounts ~14% and lags). WB API remains authoritative for ad spend, balances, CPM, budgets — data the phone can't observe.

## Data Storage

**Databases:**

- **MySQL 8.0** (primary) — container `wb-analytics-mysql`, image `mysql:8.0`, port `127.0.0.1:${MYSQL_PORT:-3306}`.
  - Connection: env vars `MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_DATABASE`/`MYSQL_USER`/`MYSQL_PASSWORD`.
  - Client: `mysql2/promise` connection pool (limit 10) — `src/db/connection.ts:24-37`. No ORM; raw SQL with `?` placeholders throughout `src/db/*-repository.ts`.
  - Schema bootstrap: `docker/init.sql` (mounted to `/docker-entrypoint-initdb.d/init.sql` in `docker-compose.yml:17`). Data volume `mysql_data`.
  - Multi-tenancy: every table has a `cabinet_id` column. Migrations are ad-hoc `ALTER TABLE IF NOT EXISTS` calls run at startup, e.g. `migrateAllowedUsersAddTelegramId()` in `src/index.ts:36-39`.

- **SQLite** (phone monitor) — `WBPartners-Auto/orders.db`.
  - Schema: `WBPartners-Auto/db.py:15-51` (`orders`, `pending_telegram` tables).
  - Journal mode: `DELETE` (rollback), **not WAL** — chosen because the file is bind-mounted single-file into the bidberry container and WAL sidecar files don't propagate (`WBPartners-Auto/db.py:64-72`).
  - Read-only mount into the main app: `./WBPartners-Auto/orders.db:/mnt/wbpartners/orders.db:ro` (`docker-compose.yml:57`). Read by `src/services/wbpartners-phone-db.ts:20-35` via `bun:sqlite` `{ readonly: true }`.
  - Pre-migration backup files committed-in-place (e.g. `WBPartners-Auto/orders.db.pre-migrate-2026-04-21`).

**File Storage:**

- Local volume `./exports` mounted to `/app/exports` (`docker-compose.yml:52`). Used by Excel exporter / report-generator (`src/excel/exporter.ts:13`).
- S3-compatible object storage for backups (NOT for app runtime). Endpoint configurable; defaults documented as `s3.firstvds.ru` in `scripts/backup/README.md:46`. Bucket layout: `daily/YYYY-MM-DD/`, `weekly/YYYY-WNN/`, `monthly/YYYY-MM/`.

**Caching:**

- In-memory only. Per-cabinet WB client cache: `Map<number, WBApiClient>` in `src/api/wb-client.ts:628`. Per-API-key emulator-ingest rate-limit cache: `Map<string, number>` in `src/web/emulator-ingest-routes.ts:7`.
- No Redis / memcached.

## Authentication & Identity

**Auth Provider:**

- Telegram Login Widget — single sign-on. No password DB.
- Implementation:
  - Frontend: widget loads bot username from `GET /api/auth/config` (`src/web/auth-routes.ts:10-14`).
  - Backend: `POST /api/auth/telegram` validates the HMAC-SHA256 over sorted Telegram fields keyed by `SHA256(TELEGRAM_BOT_TOKEN)`, constant-time compared via `node:crypto.timingSafeEqual` — `src/services/auth-service.ts:56-85`.
  - Replay window: 300s (`auth_date` must be within 5 min — `src/services/auth-service.ts:95-99`).
  - Whitelist: `cabinets.allowed_users` table — accepts by `telegram_id`, falls back to atomic claim of pending `username` row (`src/services/auth-service.ts:183-191`).
  - Session: JWT signed with `JWT_SECRET` (HS256), TTL `JWT_ACCESS_TTL` (default `24h`). Issued + verified in `src/services/auth-service.ts:136-156`. Stored as `httpOnly; Secure; SameSite=Lax` cookie `access_token` (`src/web/auth-routes.ts:24`).
  - Boot-time fail-loud: `assertJwtSecretConfigured()` called from `src/index.ts:31` rejects empty / placeholder / <32-char secrets.

**Webhook auth (server-to-server):**

- `X-Trigger-Secret` header on `/api/trigger/*` — checked in `src/web/trigger-routes.ts:29-40` with constant-time string comparison (length-padded). Must match `TRIGGER_SECRET` env on both bidberry and WBPartners-Auto sides.
- `X-Emulator-Key` header on `/api/orders/ingest` and `/api/orders/heartbeat` — looked up in `emulator_instances.api_key` (`src/web/emulator-ingest-routes.ts:11-40`); bypasses JWT in `src/web/routes.ts:42-47`.
- `X-API-Key` header on the WBPartners-Auto FastAPI — `WBPartners-Auto/api.py:73-78` (`APIKeyHeader` from FastAPI security).

**Authorization:**

- `authMiddleware` enforces JWT on `/api/*` except auth + webhook paths (`src/web/routes.ts:40-47`).
- `adminMiddleware` adds role check (`role === 'admin'`) — used in `src/web/admin-routes.ts:10` and `/api/auth/check-admin` (`src/web/auth-routes.ts:52-54`).
- nginx `auth_request` checks: `/api/auth/check-admin` and `/api/auth/check-emu` (`src/web/auth-routes.ts:52-74`).
- Per-cabinet ACL: `cabinetsRepo.userHasAccessToCabinet(userId, cabinetId)` — `src/web/auth-routes.ts:70`.

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry / Datadog / Rollbar packages or imports). Errors go to stdout via `console.error` and are captured by `docker compose logs app` and `journalctl -u wb-monitor.service`.

**Logs:**
- Plain `console.log` / `console.error` for the Bun app — captured by Docker.
- Python: `print()` to stdout — captured by systemd journal (`journalctl -u wb-monitor.service -f` per `CLAUDE.md`).
- Backup pipeline writes structured `[backup TIMESTAMP] msg` lines via `log()` in `scripts/backup/backup.sh:19`.
- Backup failure path posts a Telegram message via raw `curl` — `scripts/backup/backup.sh:22-32`.

**Metrics:**
- None exposed (no Prometheus exporter, no `/metrics` endpoint). Scheduler health is exposed only via `getStatus()` in `src/services/scheduler.ts:65-78` (consumed by admin UI).

## CI/CD & Deployment

**Hosting:**
- Single bare-metal/VPS host `ostapLase`. Working directory `/home/ostap/bidberry` IS production — no separate staging.
- Docker Compose orchestrates `app` + `mysql`. App runs in `network_mode: host` so it can reach Telegram via a localhost SOCKS/HTTP proxy (`docker-compose.yml:32`).

**CI Pipeline:**
- None (no `.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`).
- Deploy = `cd ~/bidberry && docker compose up -d --build app` (per `CLAUDE.md`).
- Python changes under `WBPartners-Auto/` require `sudo systemctl restart wb-monitor.service` — Python does not hot-reload (per `CLAUDE.md`).

**Backups:**
- `bidberry-backup.timer` + `bidberry-backup.service` (units in `scripts/backup/systemd/`) — daily 04:00 MSK with ±5 min jitter, `Persistent=true` for missed runs.
- `scripts/backup/backup.sh` produces: `mysql-all.sql.gz` (mysqldump --all-databases --single-transaction), `orders.db.gz` (SQLite live `.backup`), `envs.tar.gz.gpg` (GPG-encrypted env files), `manifest.txt`.
- Retention: 7 daily / 4 weekly / 6 monthly tiers; `scripts/backup/prune.sh` runs at end of every backup.
- Encryption: GPG asymmetric, 4096-bit RSA keypair at `/home/ostap/.gnupg-bidberry-backup/`. Operator must move private key off-server (per `scripts/backup/README.md:38`).
- Restore tooling: `scripts/backup/restore.sh`.

## Environment Configuration

**Required env vars (main app — `docker-compose.yml:36-50`):**

- `WB_API_KEY` — legacy global (active cabinets use per-row `cabinets.wb_api_key`)
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`
- `APP_PORT` (default 3000)
- `JWT_SECRET` — fail-loud at boot, must be ≥32 chars (`src/services/auth-service.ts:43-53`)
- `JWT_ACCESS_TTL` (default `24h`)
- `TRIGGER_SECRET` — must match WBPartners-Auto value
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_NAME`, `TELEGRAM_CHAT_ID`
- `TELEGRAM_PROXY_URL` (optional; needed when running in RU)

**Required env vars (WBPartners-Auto — `WBPartners-Auto/.env.example` + grep findings):**

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `API_KEY` (for the FastAPI `X-API-Key`), `API_HOST`, `API_PORT` (default 22001)
- `BIDBERRY_URL`, `BIDBERRY_CABINET_ID`, `TRIGGER_SECRET` — for the trigger callback
- `ALL_PROXY` / `all_proxy` — SOCKS proxy override (auto-rewritten from `socks://` to `socks5://` in `wb_order_monitor.py:27-31`)

**Required env vars (backups — `/etc/bidberry-backup.env`, root:root 600):**

- `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION` (per `scripts/backup/README.md:42-50`).

**Secrets location:**

- `/home/ostap/bidberry/.env` — main app secrets (committed `.env.example` only).
- `/home/ostap/bidberry/WBPartners-Auto/.env` — phone monitor secrets.
- `/etc/bidberry-backup.env` — S3 credentials (root-owned 600).
- `/home/ostap/.gnupg-bidberry-backup/` — GPG keyring for backup encryption.
- `/home/ostap/bidberry-backup-keys/private-key.asc` — exported GPG private key (operator instructed to move off-server).
- No secret manager (no Vault / AWS Secrets Manager / SOPS / dotenvx).

## Webhooks & Callbacks

**Incoming (main app):**

- `POST /api/trigger/cabinet-report/:cabinetId` — fires Telegram cabinet report; auth: `X-Trigger-Secret`. Returns 202; sends in background. `src/web/trigger-routes.ts:50-61`.
- `GET /api/trigger/cabinet-report/:cabinetId?start=&end=&label=` — generates report text without sending; used by the WBPartners-Auto Telegram bot to reply to `/count` commands. Same `X-Trigger-Secret` auth. `src/web/trigger-routes.ts:74-103`.
- `POST /api/orders/ingest` — emulator-monitor sidecar pushes scraped orders; auth: `X-Emulator-Key`; rate-limited to 1 req per 5 s per key; max 100 orders per batch. `src/web/emulator-ingest-routes.ts:9-30`.
- `POST /api/orders/heartbeat` — emulator-monitor liveness ping. `src/web/emulator-ingest-routes.ts:32-41`.

**Incoming (WBPartners-Auto FastAPI on port 22001):**

- `GET /health` — public.
- `GET /orders` (auth `X-API-Key`) — list with `limit`, `status`, `start_date`, `end_date` filters.
- `GET /orders/{article}` (auth) — by WB article.
- `GET /stats` (auth) — total / today / by_status counts.
- `GET /export/csv?start_date=&end_date=` (auth) — CSV download.
  All defined in `WBPartners-Auto/api.py:90-169`.

**Outgoing:**

- WBPartners-Auto → main app: `POST {BIDBERRY_URL}/api/trigger/cabinet-report/{BIDBERRY_CABINET_ID}` after each new-order detection (`WBPartners-Auto/wb_order_monitor.py:60-72`). Bot also calls the GET form to render `/count` replies (`WBPartners-Auto/bot.py:198-206`). Both send the `X-Trigger-Secret` header.
- WBPartners-Auto → Telegram Bot API: `sendMessage` calls in `wb_order_monitor.py:82` and via `python-telegram-bot` in `bot.py`.
- Main app → Telegram Bot API: `sendMessage` calls in `src/services/telegram-notifier.ts:25` (used for cabinet reports `src/services/cabinet-report.ts` and backup-failure alerts).
- Main app → Wildberries APIs: see "APIs & External Services" above.
- Main app → Docker Engine: HTTP over Unix socket `/var/run/docker.sock` (`src/services/docker-client.ts:6`) — used by `src/services/emulator-orchestrator.ts` to provision/start/stop/delete Redroid + scrcpy + monitor container trios per cabinet.
- Backup script → S3: `aws --endpoint-url $S3_ENDPOINT s3 cp ...` in `scripts/backup/backup.sh:70`.
- Backup script → Telegram: `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage` for failure notifications (`scripts/backup/backup.sh:30`).

---

*Integration audit: 2026-04-27*
