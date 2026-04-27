# Codebase Concerns — WB Analytics Dashboard

**Analysis Date:** 2026-04-27
**Scope:** full repo (`/home/ostap/bidberry`), focus area: technical debt, bugs, security, performance, fragile areas

This audit covers two intertwined codebases: the TypeScript/Bun web app under `src/` and the Python order-monitor under `WBPartners-Auto/` that drives the physical Huawei phone via `uiautomator2`. The cross-language seam is a single read-only SQLite bind mount. The repo lives on the production server (`ostapLase`) — every change is one `docker compose up -d --build` from prod.

## Tech Debt

**Raw SQL across 16 repository files (no ORM)**
- Issue: every table access is hand-written SQL with no central schema definitions, no migration runner, and no compile-time column checks. Schema drift surfaces only at runtime.
- Files: `src/db/repository.ts`, `src/db/cabinets-repository.ts`, `src/db/monitoring-repository.ts:25-95`, `src/db/orders-repository.ts:6-19`, plus 12 more `*-repository.ts` files.
- Impact: refactoring a column requires grepping every literal. Multi-tenancy bugs (forgetting `cabinet_id` in WHERE) compile cleanly. IN-clauses use unparameterized `${placeholders}` template literals (`monitoring-repository.ts:167,249,283,321`, `stock-repository.ts:97`).
- Fix approach: at minimum generate TS row interfaces from `INFORMATION_SCHEMA`. Long-term: a typed query builder (Kysely / Drizzle).

**Two coexisting ad-hoc migration tools**
- Issue: schema changes split between `src/cli/migrate-multi-cabinet.ts` (idempotent block per change) and `WBPartners-Auto/migrate*.py` (one-shot `--confirm` scripts). No single chronological history.
- Files: `src/cli/migrate-multi-cabinet.ts:85-175`, `WBPartners-Auto/migrate.py`, `WBPartners-Auto/migrate_rekey.py`, `WBPartners-Auto/migrate_schema_strict_keys.py`, plus startup-time `migrateAllowedUsersAddTelegramId` (`src/db/cabinets-repository.ts:176-188`).
- Impact: provisioning a fresh dev DB requires knowing the order. The uncommitted backup files `WBPartners-Auto/orders.db.pre-cleanup-2026-04-21` and `orders.db.pre-migrate-2026-04-21` sit next to live data.
- Fix approach: consolidate into a `migrations/` directory with a single runner that records applied migrations.

**N+1 inserts in every batch upsert**
- Issue: every `*Batch` function loops in JS and runs one INSERT per row instead of multi-VALUES.
- Files: `src/db/repository.ts:42-49,105-112` (`upsertCampaigns`, `upsertCampaignStatsBatch`), `src/db/orders-repository.ts:51-62` (`upsertOrdersBatch`), `src/db/monitoring-repository.ts:48-58,84-94` (expense/payment batches), `src/db/emulator-repository.ts:218-253` (phone-ingest webhook).
- Impact: 30-day orders sync (~15k rows/cabinet) does 15k round-trips. Visible as slow `orders-sync` task runs.
- Fix approach: chunked `INSERT ... VALUES (?,?,?), ...` at ~500 rows per statement.

**Untyped WB API responses**
- Issue: most WB methods return `any` or `Promise<any[]>`; consumers `?.` through nested optionals.
- Files: `src/api/wb-client.ts:104-119,402-419,481-488,491-505`, `src/services/financial-service.ts:6-39` (handles two response shapes side by side via `commission_percent ?? ppvz_kvw_prc_base`).
- Impact: silent breakage when WB renames a field. Bugs surface as 0/null where data should exist.
- Fix approach: zod schemas at the WB API boundary; failures become loud typed errors with the offending payload.

**Three competing order-storage layers**
- Issue: orders live in three tables across two databases:
  1. WB API → MySQL `orders` (`src/db/orders-repository.ts`)
  2. Phone scraping → SQLite `orders` (`WBPartners-Auto/db.py:15-50`) — *authoritative*
  3. Redroid emulator-ingest → MySQL `emu_orders` (`src/db/emulator-repository.ts:194-253`)
- Files: above + `src/services/cabinet-report.ts` (mixes phone + MySQL `orders`), `src/web/emulator-ingest-routes.ts`.
- Impact: `emu_orders` is unused by reporting today (Redroid is fallback only). Three sources of truth for one entity is a long-term burden.
- Fix approach: pick the phone DB as canonical; either drop `emu_orders` or formalize it as the future replacement.

**`emu_orders` dedup-key built via raw `|` concat**
- Issue: `${order.article}|${order.size ?? ''}|${order.status ?? ''}|${order.date_raw ?? ''}` (`src/db/emulator-repository.ts:219`) collides whenever any field contains `|`, and treats `null` and `''` identically.
- Files: `src/db/emulator-repository.ts:218-253`.
- Impact: not biting today (path is fallback). If Redroid becomes primary, malformed parser output silently dedups distinct orders.
- Fix approach: SHA-256 of canonicalized JSON, or mirror `WBPartners-Auto/db.py:113-154`'s `build_key` which strips `#` from each field.

**`upsertOrdersBatch` swallows every exception**
- Issue: `try { ... } catch (e) { /* Skip duplicates/errors */ }` (`src/db/orders-repository.ts:54-59`) treats schema mismatches, connection drops, and dup-keys identically.
- Files: `src/db/orders-repository.ts:51-62`.
- Impact: a permanent schema mismatch (e.g. WB lengthens `srid`) silently loses 100% of orders forever; only signal is a count delta.
- Fix approach: only swallow specific `ER_DUP_ENTRY`; log+rethrow everything else. Mirror the explicit check in `WBPartners-Auto/db.py:200-205`.

**`forEachCabinet` runs cabinets sequentially**
- Issue: `src/index.ts:48-62` iterates one at a time. Every scheduled task scales linearly with cabinet count.
- Files: every `scheduler.registerTask` callsite in `src/index.ts`.
- Impact: with >5 cabinets, the 15-min `orders-sync-fast` risks overlapping with itself. The "still running" guard at `src/services/scheduler.ts:32-44` then drops cycles silently.
- Fix approach: `Promise.allSettled` with concurrency=3. Per-cabinet error isolation is preserved.

**Dead code in `bot.py`**
- Issue: the recent uncommitted edit removed `get_orders_by_date_range`, `get_totals`, `get_totals_by_article` from the local-fallback path (`WBPartners-Auto/bot.py:14`). `get_totals` and `get_totals_by_article` now have no callers.
- Files: `WBPartners-Auto/db.py:284-327`, `WBPartners-Auto/bot.py:14`.
- Fix: delete unused query functions (only `get_orders_by_date_range` is still consumed by `api.py:18-24`).

## Known Bugs

**`recount_today.py` references stale path in error message**
- Symptom: tells the user to run `bash /home/ostap/WBPartners-Auto/recount_today.sh` — the pre-2026-04-20 path. Correct path is `/home/ostap/bidberry/WBPartners-Auto/recount_today.sh`.
- Files: `WBPartners-Auto/recount_today.py:165`.
- Workaround: ignore the message; the wrapper exists at the right place.

**`getOrders` uses `dateTo + ' 23:59:59'` — TZ-dependent**
- Symptom: `dateTo=2026-04-26` matches up to `23:59:59` in MySQL session-local TZ, not necessarily MSK.
- Files: `src/db/orders-repository.ts:80-81,120-121`.
- Impact: orders placed near midnight MSK may be miscategorized. The `cabinet-report.ts` flow bypasses this with explicit timestamps; `/api/orders` REST endpoint is exposed.
- Fix: switch to half-open `< nextDayStart`.

**`Set-Cookie: Secure` breaks plain-HTTP deployments**
- Symptom: `Set-Cookie: access_token=...; Secure` (`src/web/auth-routes.ts:24,47`) — browsers refuse the cookie over `http://`.
- Files: `src/web/auth-routes.ts:24,47`.
- Workaround: works on production HTTPS. Fix: gate `Secure` on `NODE_ENV === 'production'` or a `COOKIE_SECURE` flag.

**Long sync ticks silently drop**
- Symptom: scheduler skips a cycle when previous still running (`src/services/scheduler.ts:33`) — no log line, no metric.
- Files: `src/services/scheduler.ts:32-44`.
- Fix: emit `[scheduler] skipped tick of <task>` warning + a "skipped tick" counter in `getStatus()`.

**Smart bidder picks arbitrary keyword for campaign-level signals**
- Symptom: `currentBids[0]?.keyword` (`src/services/smart-bidder.ts:46`) is used when `rule.keyword` is null. For `target_position`/`target_cpc` strategies that pulls position/CPC from one arbitrary keyword.
- Files: `src/services/smart-bidder.ts:41-66`.
- Fix: reject null-keyword rules for position/CPC strategies, or aggregate across the campaign.

**`verifyTelegramAuth` collapses two failure modes silently**
- Symptom: `if (!data.hash || data.hash.length !== expectedHex.length) return false` (`src/services/auth-service.ts:79`) returns `false` for both "missing hash" and "wrong-length hash" with no log.
- Files: `src/services/auth-service.ts:56-85`.
- Fix: add a `[auth] hash format invalid` diagnostic before returning.

## Security Considerations

**Docker socket mounted into the app container**
- Risk: `/var/run/docker.sock` is bound into `wb-analytics-app` (`docker-compose.yml:53`). RCE inside Bun = root on host (Docker daemon runs as root). The app spawns Redroid containers via `src/services/emulator-orchestrator.ts:60-167`.
- Files: `docker-compose.yml:53`, `src/services/docker-client.ts:6,61-74`, `src/services/emulator-orchestrator.ts:60-167`.
- Current mitigation: emulator admin routes require admin role (`src/web/emulator-admin-routes.ts:10`); container is `network_mode: host` (`docker-compose.yml:32`). No socket-proxy or option allowlist; `Privileged: true` is hard-coded for Redroid (`emulator-orchestrator.ts:71`).
- Recommendations: add `tecnativa/docker-socket-proxy` allowlisting only required paths; validate every container option against an allowlist in `docker-client.ts`; audit admins.

**`network_mode: host` for the app container**
- Risk: app shares host network namespace (`docker-compose.yml:32`). The comment in `src/web/trigger-routes.ts:6-8` explicitly notes that `127.0.0.1` is not a real auth boundary in this mode — `TRIGGER_SECRET` is the only barrier.
- Files: `docker-compose.yml:32`, `src/web/trigger-routes.ts:6-46`, `src/web/routes.ts:36-46` (auth-bypass list for `/api/trigger/*`, `/api/orders/ingest`, `/api/orders/heartbeat`).
- Current mitigation: constant-time comparison with length-equality enforcement (`trigger-routes.ts:17-27`), 16-char minimum check; emulator ingest uses `X-Emulator-Key` with DB lookup (`emulator-ingest-routes.ts:11-21`).
- Recommendations: keep secret-based auth; add a host firewall rule blocking `:3000` from non-loopback so a bug listening on `0.0.0.0` doesn't go public.

**WB API key stored plaintext in `cabinets.wb_api_key`**
- Risk: every cabinet's WB API token (long-lived, full marketplace access) sits as plaintext in MySQL.
- Files: `src/db/cabinets-repository.ts:118-141`, `src/web/admin-routes.ts:73-104`.
- Current mitigation: MySQL bound to `127.0.0.1:3306`; daily backups GPG-encrypted (`scripts/backup/backup.sh:115-119`).
- Recommendations: encrypt at rest with libsodium secretbox keyed by an env-var; decrypt on read in `getActiveCabinets`. Bounds blast radius if MySQL volume leaks but env doesn't.

**Default credentials baked into compose**
- Risk: `MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootpassword}` (`docker-compose.yml:9`). If `.env` is missing the var, deploy comes up with literal `rootpassword`.
- Files: `docker-compose.yml:9-12`.
- Fix: drop defaults; use `${MYSQL_ROOT_PASSWORD:?required}` (mirroring the recent JWT_SECRET hardening).

**`getDBConfig` falls back to weak defaults**
- Risk: defaults to `wb_user/wb_password/wb_analytics` (`src/db/connection.ts:14-22`). If MySQL was provisioned with strong creds but the app env is missing them, app silently tries the wrong creds.
- Files: `src/db/connection.ts:14-22`.
- Fix: throw at startup if any of `MYSQL_HOST/USER/PASSWORD/DATABASE` is unset, mirroring `assertJwtSecretConfigured` (`src/services/auth-service.ts:43-53`).

**`/api/orders/ingest` lacks rotation/audit**
- Risk: explicitly excluded from auth (`src/web/routes.ts:42-45`); only validated by `X-Emulator-Key` lookup (`src/web/emulator-ingest-routes.ts:14`). Key generated via `crypto.getRandomValues` (`src/services/emulator-orchestrator.ts:34-39`) is unguessable, but if it leaks (DB column, container env, log), there's no rotation path or HMAC alternative.
- Files: `src/services/emulator-orchestrator.ts:34-39,128-134`, `src/db/emulator-repository.ts:72-78`, `src/web/emulator-ingest-routes.ts`.
- Current mitigation: 5s in-memory rate limit per key (lost on restart).
- Recommendations: log every successful ingest; add rotation endpoint; consider HMAC-over-body+timestamp instead of bearer.

**WBPartners-Auto FastAPI default-binds `0.0.0.0`**
- Risk: `API_HOST = os.getenv("API_HOST", "0.0.0.0")` (`WBPartners-Auto/api.py:29`). If `.env` doesn't override, FastAPI listens on all interfaces.
- Files: `WBPartners-Auto/api.py:28-77`.
- Current mitigation: `verify_api_key` correctly rejects when `API_KEY` is unset (`api.py:76-78` — `not API_KEY or key != API_KEY` is True for both branches → safe deny). However `/health` (`api.py:90`) lacks the `Security` dependency and leaks `orders_in_db`.
- Recommendations: default `API_HOST=127.0.0.1`; auth `/health` or strip the leaky field.

**Username-based whitelist claim is one-shot but doesn't audit**
- Risk: Telegram usernames are reusable after release. `claimPendingUsername` (`src/db/cabinets-repository.ts:223-240`) atomically locks a pending row to a telegram_id but doesn't log the bind or surface it for admin review.
- Files: `src/services/auth-service.ts:87-134,183-191`, `src/db/cabinets-repository.ts:223-240`.
- Current mitigation: documented tradeoff (`cabinets-repository.ts:163-174`); the claim is atomic.
- Recommendations: log every claim with old/new telegram_id; require admin "release" before reclaim.

## Performance Bottlenecks

**Search-queries sync sleeps 20s × N batches**
- Problem: `src/services/search-analytics-service.ts:59` sleeps 20s between batches (rate limit: 3 req/min). 1000 products = ~17 min per cabinet, run sequentially across cabinets.
- Cause: WB rate-limit per-API-key is per-key, but `forEachCabinet` serializes anyway.
- Improvement: parallelize across cabinets (different keys = independent quotas).

**Product-analytics sync re-pulls yesterday daily**
- Problem: `product-analytics-sync` (12h cadence) re-fetches yesterday + today every run (`src/index.ts:186-207`). Yesterday's analytics are immutable past midnight UTC+3.
- Cause: simplest "always sync recent window" loop.
- Improvement: skip days >36h old; halves WB API load on slow path.

**Smart bidder always fetches full bid list**
- Problem: `getBids(campaignId)` runs per-campaign every 30min (`src/services/smart-bidder.ts:34`), even when no rule needs current bid data (e.g. `max_bid` strategy).
- Improvement: pre-filter rules; only fetch when needed.

**Phone DB SQLite handle cached for process lifetime**
- Problem: `bun:sqlite` opens once and reuses (`src/services/wbpartners-phone-db.ts:24-35`). Host file is `journal_mode=DELETE` (`WBPartners-Auto/db.py:71`), but a backup `sqlite3 .backup` overwrite or migration replacing the file may not be picked up by the cached handle.
- Improvement: open+close per query (one call per 15-min report cycle = trivial cost) or PRAGMA-driven cache flush.

**`generateCabinetReport` does 4 queries per SKU**
- Problem: per-row loop calls `getCampaignsForProduct`, `getHourlySpendFromSnapshots`, `getSpendForCampaigns`, `getOrderCountForProduct` (`src/services/cabinet-report.ts:86-132`). 30 SKUs = 120 queries per report.
- Mitigation: 60s cooldown (`cabinet-report.ts:159`) + 15min scheduler cadence prevent compounding today.
- Improvement: one query per metric over all `nmId`s using `IN`.

**`withRetry` stalls up to 60s per 429**
- Problem: max-delay 60s, max-retries 3 (`src/utils/retry.ts:9-14,63-69`). A 429 with no `Retry-After` header sleeps 60s.
- Improvement: smaller max-delay (10-15s) for non-critical paths; per-task timeout enforcing one cabinet can't hold the whole tick.

## Fragile Areas

**Phone-side automation depends on Russian UI labels + screen pixels**
- Files: `WBPartners-Auto/wb_order_monitor.py:438-459` (text matches `Лента заказов`, hard-coded swipes `900,2080→100,2080` and tap `880,2045`); `wb_order_monitor.py:551-577` (parses `"Дата оформления"`, `"Прибытие"`, `"Склад WB"`); `wb_order_monitor.py:303-308` (error screen detected by literal string `"Что-то пошло не так"`).
- Why fragile: WB Partners app updates rename labels, shift layouts, or add floating buttons (line 449 already documents avoiding the bot button at `[906,2056]`).
- Safe modification: pair every coordinate change with a manual `recount_today.py --force` against a known day.
- Test coverage: only `WBPartners-Auto/test_build_key.py` for dedup-key building. Parser is validated by running against live WB.

**`handle_error_state` recovery state machine**
- Files: `WBPartners-Auto/wb_order_monitor.py:311-391`.
- Why fragile: global `_consecutive_errors` counter drives 5-tier escalation; `_recovering` flag prevents recursion. A future bug that sets `_recovering=True` outside the `try/finally` silently disables recovery forever.
- Safe modification: never add early returns inside the `_recovering=True; try: ...; finally: _recovering=False` block. Add a watchdog log if `_recovering` stays true longer than a cycle.

**`bot.py` runs in a daemon thread that auto-restarts forever**
- Files: `WBPartners-Auto/bot.py:307-358`.
- Why fragile: `Application.builder().token(...)` raising synchronously (token unset) crashes the thread, which retries with exponential backoff up to 5min — parent monitor stays "healthy" but bot is dead.
- Safe modification: `wb_order_monitor.py:769-771` only blocks if BOTH bot+chat tokens are unset. Add a strict fail-loud check on `TELEGRAM_BOT_TOKEN` before spawning the thread.

**Compose uses host networking; no compose-level guard against `0.0.0.0` binding**
- Files: `docker-compose.yml:30-32`, `src/index.ts:586-603` (`Bun.serve({ hostname: '127.0.0.1' })`).
- Why fragile: any port the Bun process opens is on the host. A regression flipping `127.0.0.1` to `0.0.0.0` exposes everything publicly.
- Safe modification: keep `hostname` literal; gate any change behind a config var defaulting to loopback. Add ufw/nftables rule blocking `:3000` inbound.

**`forEachCabinet` swallows per-cabinet errors with no escalation**
- Files: `src/index.ts:48-62`.
- Why fragile: a cabinet whose WB API key was revoked logs an error every interval but never escalates. Dashboard shows stale data; nobody notices unless they check logs.
- Safe modification: track per-cabinet "consecutive failure count" and surface in admin UI. `cabinetsRepo.updateCabinetLastSync` (`src/db/cabinets-repository.ts:148-150`) is only called on success — there's no failure metric.

**`recount_today.py` requires service to be stopped**
- Files: `WBPartners-Auto/recount_today.py:33-38,162-166`.
- Why fragile: two processes contending for one ADB device = undefined behavior. `is_service_active()` checks `systemctl is-active` literal stdout (`active`); systemd phrasing changes break the guard. `--force` bypasses it entirely.
- Safe modification: use `systemctl show -p ActiveState --value`; better, have `recount_today.sh` handle stop/start so the Python doesn't need to know about systemd.

**`/count` lost local-SQLite fallback in the recent uncommitted diff**
- Files: `WBPartners-Auto/bot.py:201-203,279-289`.
- Why fragile: removed fallback means an unconfigured/unavailable bidberry yields a flat error to the user instead of a degraded answer. `BIDBERRY_CABINET_ID` missing in `.env` → permanent "не настроен" forever.
- Safe modification: re-add a minimal local-DB fallback for the `unconfigured` and `unavailable` branches.

**Python systemd service does NOT hot-reload**
- Files: `WBPartners-Auto/wb_order_monitor.py`, `WBPartners-Auto/bot.py`, `WBPartners-Auto/db.py`, `WBPartners-Auto/server.py`.
- Why fragile: per `CLAUDE.md`, edits under `./WBPartners-Auto/` require `sudo systemctl restart wb-monitor.service`. Easy to forget — code in the repo says one thing while the running process does another. Currently 4 modified `.py` files are uncommitted with potentially-not-restarted state.
- Safe modification: codify the restart in a deploy script; add a startup self-log of file mtimes so log triage can spot drift.

## Scaling Limits

**MySQL pool capped at 10 connections**
- Current capacity: `connectionLimit: 10` (`src/db/connection.ts:30`). Shared by scheduler + web + CLI.
- Limit: under burst (concurrent web + active sync), requests queue silently.
- Scaling path: bump to 30-50; verify MySQL `max_connections` keeps up.

**Emulator ports bounded to 20**
- Current capacity: `ADB_PORT_MIN=5555/MAX=5574`, `SCRCPY_PORT_MIN=22090/MAX=22109` (`src/db/emulator-repository.ts:47-50`).
- Limit: 21st cabinet emulator throws (`emulator-repository.ts:108-121`). Memory ceiling tighter: each Redroid is 1.5GB + monitor 256MB (`emulator-orchestrator.ts:78,138`).
- Scaling path: widen ranges; right-size host RAM if Redroid path becomes primary.

**Single Bun process, no workers**
- Current capacity: one `Bun.serve` event loop drives scheduler + web + sync.
- Limit: synchronous CPU work (`src/excel/report-generator.ts`, 461 lines) blocks every other request. `bun:sqlite` is sync.
- Scaling path: `Worker` for Excel; separate scheduler from web; horizontal scale impossible while emulator-orchestrator assumes single Docker daemon.

## Dependencies at Risk

**WB API endpoint stability**
- Risk: WB silently moves/deprecates endpoints. Already-defensive normalization in `src/api/wb-client.ts:432-443` (`getCampaignBudget` mapping `total → budget`) and `wb-client.ts:251-289` (`getProductAnalytics` v3 reshape).
- Migration plan: snapshot known-good responses in `tests/fixtures/wb-api/`; daily smoke test diffs live shape against snapshot, alerts on divergence.

**`uiautomator2` + Huawei device-specific quirks**
- Risk: `WBPartners-Auto/wb_order_monitor.py:464` notes "Use ADB shell input swipe to bypass Huawei INJECT_EVENTS issue." Whole automation is shaped by this one device's behavior.
- Migration plan: document device model in `WBPartners-Auto/CLAUDE.md`; treat the Redroid path as a long-term replacement so the repo isn't trapped on one hardware unit.

**`redroid/redroid:14.0.0-latest` floating tag**
- Risk: `:latest` (`src/services/emulator-orchestrator.ts:17`) means upstream pushes change behavior on next pull.
- Migration plan: pin to digest (`@sha256:...`).

## Missing Critical Features

**No metrics/alerting except Telegram**
- Problem: no Prometheus, no public health endpoint, no per-task last-success timestamp accessible externally. Scheduler status (`src/services/scheduler.ts:65-78`) is admin-only.
- Blocks: paging on "task X failing 6h" requires manual log triage.

**No structured logging**
- Problem: every component uses `console.log` with ad-hoc strings. No correlation IDs, no JSON-line output, no log levels. Multi-source forensics span Docker logs + systemd journal for `wb-monitor.service` + cron for backups.

**No request-level rate limiting on web app**
- Problem: only CORS + auth middleware on `/api/*` (`src/web/routes.ts:28,40-46`). A logged-in user can hammer any endpoint. Phone-ingest has its own 5s limit; no other endpoints do.
- Blocks: a leaked JWT (or rogue admin) can DOS the WB API by triggering syncs in a loop.

**No backup verification**
- Problem: `scripts/backup/backup.sh` produces daily S3 uploads with manifests + SHA-256, but no `restore-test.sh` that periodically downloads + decrypts + restores into a sandbox.
- Blocks: silent backup corruption is found only at restore time.

## Test Coverage Gaps

**Phone-DB integration not covered**
- Files: `src/services/wbpartners-phone-db.ts:50-74`.
- Risk: cross-language SQLite contract drift (Python adds a column TS doesn't read for, or vice versa) → `getPhoneTotalsByArticle` silently returns `[]` and the cabinet report says "nothing to report."
- Priority: **High** — this is the source of truth for orders.

**Scheduler error-isolation unverified**
- Files: `src/services/scheduler.ts`, `src/index.ts:48-62`.
- Risk: regression where one cabinet's error blocks others would not be caught.
- Priority: **High**.

**Docker socket integration unverified**
- Files: `src/services/docker-client.ts:97-116` (multiplexed-stream parser, non-trivial), `src/services/emulator-orchestrator.ts:362-446` (health-check timing, `heartbeatAge > 120_000`).
- Risk: Docker API minor-version change of the multiplexed log format → log retrieval silently returns garbage.
- Priority: **Medium** (Redroid is fallback today; high if it becomes primary).

**Smart bidder strategy logic unverified**
- Files: `src/services/smart-bidder.ts:71-121` (`calculateNewBid`).
- Risk: a strategy bug silently mis-prices ads — a CPC strategy decreasing bids on low CPC instead of increasing them costs real money over a 30-min cycle.
- Priority: **High** — this writes to a paid system.

**Repository SQL not exercised against a real schema in CI**
- Files: 16 `*-repository.ts` files; only `auth-service`, `cabinet-report`, `admin-routes`, `auth-middleware`, `cabinet-context`, `cabinet-routes`, `trigger-routes`, `wb-client` (factory only), `report-generator` have `*.test.ts` neighbors.
- Risk: SQL syntax errors and column-name typos are caught only at runtime. A missing `cabinet_id` filter regression could cross-leak tenant data.
- Priority: **High** — multi-tenant correctness.

**WBPartners-Auto Python parser untested**
- Files: `WBPartners-Auto/wb_order_monitor.py:501-606` (`parse_orders_from_hierarchy`), the scroll/recovery state machine, the new `pending_telegram` queue (`WBPartners-Auto/db.py:330-405`).
- Risk: parser regression silently drops orders. `dropped_incomplete` counter is logged but not alerted on.
- Priority: **High** — every dropped order is a missed sale signal.

**Telegram delivery + replay unverified**
- Files: `WBPartners-Auto/wb_order_monitor.py:75-180` (`_send_telegram_once`, `flush_pending_telegram`), `WBPartners-Auto/db.py:334-405` (queue + max-attempts purge).
- Risk: 429-with-no-`retry_after` or malformed-HTML stuck-message paths.
- Priority: **Medium** — `PENDING_TG_MAX_ATTEMPTS = 20` bounds the worst case.
