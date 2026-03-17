# Multi-Tenant Android Emulator Orchestration (Redroid)

**Date**: 2026-03-17
**Status**: Draft
**Scope**: Per-cabinet Redroid emulator instances orchestrated by the Bun app via Docker Engine API

---

## 1. Problem Statement

The current WBPartners-Auto setup runs a single shared Redroid emulator. As the platform scales to multiple users each with their own WB Partners seller account, each user needs an isolated Android emulator instance running the order monitor 24/7.

## 2. Why Redroid

- **No KVM required** — runs Android natively in the Linux kernel (not QEMU). The host is a KVM guest without nested virtualization (`svm` flag not exposed), so QEMU-based solutions (budtmo/docker-android, Selenoid) are not viable.
- **Already proven** — Redroid 14.0.0 is running on this host today.
- **Lightweight** — ~1GB RAM per instance vs ~4GB for QEMU-based emulators.
- **Fast boot** — 30-60 seconds vs 2-3 minutes for QEMU.

## 3. Requirements

- **Always-on**: Emulators run 24/7, surviving container restarts via persistent volumes
- **Scale**: 2-5 concurrent instances on a single host (near term)
- **Data flow**: Orders from each emulator feed into MySQL via HTTP, scoped by `cabinet_id`
- **Access control**: Admin provisions instances for cabinets; users can start/stop/view their own
- **No Telegram**: Emulator pushes data to MySQL only; dashboard handles notifications
- **State persistence**: Android state (apps, logins) survives restarts via Docker volumes
- **State import**: ADB backup/restore for transferring app state from local PCs
- **Web viewer**: Per-user authenticated web-based Android screen access

## 4. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Bun App (runs on host, not in Docker)                   │
│  ├── /api/admin/emulators/*     (admin CRUD)             │
│  ├── /api/emulators/*           (user start/stop/view)   │
│  ├── /api/orders/ingest         (monitor → MySQL)        │
│  ├── /api/orders/heartbeat      (monitor health)         │
│  └── EmulatorOrchestrator       (Docker Engine API)      │
├──────────────────────────────────────────────────────────┤
│  Docker Engine API (unix socket /var/run/docker.sock)    │
│                                                          │
│  Per-cabinet container trio:                             │
│  ┌─────────────────────────────────────────────────┐     │
│  │ emu-cabinet-{id}  (redroid:14.0.0-latest)        │    │
│  │  ├── Android 14 (kernel-level, no QEMU)           │    │
│  │  ├── ADB on 127.0.0.1:{5555+N}                   │    │
│  │  └── Volume: emu-data-{id} (/data)                │    │
│  ├─────────────────────────────────────────────────┤     │
│  │ scrcpy-cabinet-{id}  (ws-scrcpy:v0.8.0)          │    │
│  │  ├── Web UI on port {9090+N}                      │    │
│  │  └── Connects to Redroid ADB via host network     │    │
│  ├─────────────────────────────────────────────────┤     │
│  │ monitor-cabinet-{id}  (wb-emu-monitor:1.0)        │    │
│  │  ├── Python + uiautomator2 (ADB over host net)    │    │
│  │  ├── POSTs orders → /api/orders/ingest             │    │
│  │  └── Started/stopped by user (not auto-start)      │    │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
│  (repeated for each cabinet)                             │
├──────────────────────────────────────────────────────────┤
│  Nginx                                                   │
│  └── /emu/{id}/ → proxy to scrcpy-cabinet-{id} web port │
│      (auth_request validates user has cabinet access)    │
└──────────────────────────────────────────────────────────┘
```

### Components

1. **EmulatorOrchestrator** (`src/services/emulator-orchestrator.ts`) — Talks to Docker Engine API via unix socket. Manages container pairs (redroid + ws-scrcpy). Allocates ports. Generates nginx config.

   **Runtime note**: The Bun app currently runs inside Docker (`wb-analytics-app` container). To access the Docker Engine API, mount the socket: `-v /var/run/docker.sock:/var/run/docker.sock`. For nginx config generation, mount the config directory: `-v /etc/nginx/conf.d:/etc/nginx-conf`. The actual `nginx -s reload` is triggered via a lightweight host-side file watcher (inotifywait on the config file) or by calling `docker exec` on the host's nginx process. Alternatively, if Bun is migrated to run directly on the host in the future, these mounts become unnecessary.

2. **Emulator Admin Routes** (`src/web/emulator-admin-routes.ts`) — Admin-only: create instance for a cabinet, delete instance, list all, force-restart, view logs.

3. **Emulator User Routes** (`src/web/emulator-routes.ts`) — User-facing: start/stop emulator, start/stop monitor, get status.

4. **Order Ingest Endpoint** (`POST /api/orders/ingest`) — Receives order batches from the Python monitor. Authenticated via per-instance `X-Emulator-Key` (bypasses JWT middleware). Upserts into `emu_orders` table.

5. **Heartbeat Endpoint** (`POST /api/orders/heartbeat`) — Same auth. Updates `last_heartbeat` timestamp. Also bypasses JWT middleware.

6. **Monitor Docker Image** (`wb-emu-monitor:1.0`) — Python 3.12 slim + uiautomator2 + ADB. Runs as a sidecar container connecting to Redroid via ADB. Redroid image is used unmodified.

7. **Emulator DB Repository** (`src/db/emulator-repository.ts`) — CRUD for `emulator_instances` table.

## 5. Database Schema

### emulator_instances

```sql
CREATE TABLE emulator_instances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL UNIQUE,
  emu_container_id VARCHAR(64),
  scrcpy_container_id VARCHAR(64),
  monitor_container_id VARCHAR(64),
  emu_container_name VARCHAR(100) NOT NULL,
  scrcpy_container_name VARCHAR(100) NOT NULL,
  monitor_container_name VARCHAR(100) NOT NULL,
  status ENUM('created','running','stopped','error') DEFAULT 'created',
  monitor_status ENUM('stopped','running','error') DEFAULT 'stopped',
  adb_port INT NOT NULL,
  scrcpy_port INT NOT NULL,
  ingest_api_key VARCHAR(64) NOT NULL,
  last_heartbeat TIMESTAMP NULL,
  error_message TEXT,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (cabinet_id) REFERENCES cabinets(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
```

### emu_orders

```sql
CREATE TABLE emu_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  dedup_key VARCHAR(255) NOT NULL,
  article VARCHAR(50) NOT NULL,
  product VARCHAR(500),
  size VARCHAR(50),
  quantity VARCHAR(20),
  status VARCHAR(50),
  price VARCHAR(50),
  price_cents INT,
  date_raw VARCHAR(100),
  date_parsed DATETIME,
  category VARCHAR(200),
  warehouse VARCHAR(200),
  arrival_city VARCHAR(200),
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_dedup (cabinet_id, dedup_key),
  INDEX idx_cabinet (cabinet_id),
  INDEX idx_article (cabinet_id, article),
  INDEX idx_status (cabinet_id, status),
  INDEX idx_first_seen (cabinet_id, first_seen),
  FOREIGN KEY (cabinet_id) REFERENCES cabinets(id)
);
```

Key constraints:
- `cabinet_id UNIQUE` on `emulator_instances` — one emulator per cabinet
- `ingest_api_key` — 64-char hex via `crypto.getRandomValues(new Uint8Array(32))`
- `emu_orders` is separate from the WB API `orders` table (different schemas)
- `dedup_key` = `article + size + status + date_raw`

## 6. Container Lifecycle

### States

| State | Emulator | Monitor | User Actions |
|-------|:--------:|:-------:|-------------|
| **Stopped** | off | off | Start Emulator |
| **Running (setup)** | on | off | Open viewer, install WB app, login. Then: Start Monitor |
| **Monitoring** | on | on | Stop Monitor, Stop Emulator |
| **Error** | crashed | off | Force Restart, Delete |

### Creation Flow

1. Admin calls `POST /api/admin/emulators` with `{ cabinetId }`
2. Validate cabinet exists and has no emulator
3. **Inside MySQL transaction**: allocate ports (query used ports, pick lowest free in range ADB: 5555-5574, scrcpy: 9090-9109), generate `ingest_api_key`, INSERT `emulator_instances` row with status `created`. This claims the ports atomically before any Docker calls.
4. Create Redroid container via Docker Engine API
5. Create ws-scrcpy container
6. UPDATE `emulator_instances` with `emu_container_id` and `scrcpy_container_id`
7. Generate nginx config (atomic write: temp file → `nginx -t` → rename → `nginx -s reload`)

If Docker container creation fails (step 4-5), the DB row is cleaned up. If the Bun process crashes between step 3 and 6, the health monitor detects orphaned rows (status `created` with no container IDs) and cleans them up.

### Redroid Container Config

```json
{
  "Image": "wb-emu-redroid:14.0",
  "Cmd": [
    "androidboot.redroid_width=1080",
    "androidboot.redroid_height=1920",
    "androidboot.redroid_dpi=440",
    "androidboot.redroid_fps=15",
    "androidboot.redroid_gpu_mode=guest",
    "androidboot.use_memfd=true"
  ],
  "Env": [],
  "HostConfig": {
    "Privileged": true,
    "Binds": ["emu-data-{cabinetId}:/data"],
    "PortBindings": {
      "5555/tcp": [{"HostIp": "127.0.0.1", "HostPort": "{adb_port}"}]
    },
    "Memory": 1610612736,
    "NanoCpus": 2000000000,
    "RestartPolicy": {"Name": "unless-stopped"}
  },
  "Labels": {
    "wb.cabinet_id": "{id}",
    "wb.managed": "true",
    "wb.type": "redroid"
  },
  "Healthcheck": {
    "Test": ["CMD-SHELL", "getprop sys.boot_completed | grep -q 1"],
    "Interval": 10000000000,
    "Timeout": 5000000000,
    "Retries": 30,
    "StartPeriod": 60000000000
  }
}
```

Notes:
- `172.17.0.1` is Docker's default bridge gateway to the host. Verified to work on this Linux host (no `host.docker.internal` needed, avoids the `--add-host` requirement).
- `Memory: 1.5GB` — Redroid is lightweight, no QEMU overhead.
- `Privileged: true` — required for Redroid's kernel-level Android.
- Volume `/data` persists Android userdata (apps, logins, settings).

### ws-scrcpy Container Config

```json
{
  "Image": "scavin/ws-scrcpy:v0.8.0",
  "Env": ["WS_SCRCPY_CONFIG=/ws-scrcpy/config.yaml"],
  "Entrypoint": ["/bin/bash"],
  "Cmd": ["-c", "adb connect 127.0.0.1:{adb_port} && sleep 3 && npm start"],
  "HostConfig": {
    "NetworkMode": "host",
    "Binds": ["/etc/wb-emulators/ws-scrcpy-{cabinetId}.yaml:/ws-scrcpy/config.yaml:ro"],
    "RestartPolicy": {"Name": "unless-stopped"}
  },
  "Labels": {
    "wb.cabinet_id": "{id}",
    "wb.managed": "true",
    "wb.type": "scrcpy"
  }
}
```

Per-instance ws-scrcpy config generated at `/etc/wb-emulators/ws-scrcpy-{cabinetId}.yaml`:
```yaml
runGoogTracker: true
announceGoogTracker: true
server:
  - secure: false
    port: {scrcpy_port}
```

### Monitor Container Config

```json
{
  "Image": "wb-emu-monitor:1.0",
  "Env": [
    "ADB_DEVICE=127.0.0.1:{adb_port}",
    "INGEST_URL=http://127.0.0.1:3000/api/orders/ingest",
    "HEARTBEAT_URL=http://127.0.0.1:3000/api/orders/heartbeat",
    "EMULATOR_KEY={ingest_api_key}",
    "CABINET_ID={cabinet_id}"
  ],
  "HostConfig": {
    "NetworkMode": "host",
    "Memory": 268435456,
    "NanoCpus": 500000000,
    "RestartPolicy": {"Name": "no"}
  },
  "Labels": {
    "wb.cabinet_id": "{id}",
    "wb.managed": "true",
    "wb.type": "monitor"
  }
}
```

Notes:
- `NetworkMode: host` — accesses Redroid ADB on `127.0.0.1:{adb_port}` and Bun app on `127.0.0.1:3000`
- `RestartPolicy: no` — monitor is explicitly started/stopped by user, not auto-restarted
- `Memory: 256MB`, `CPU: 0.5 cores` — lightweight Python process
- Container is created at provisioning time but NOT started until user clicks "Start Monitor"

### User Controls

- **Start Emulator**: Docker start redroid, then scrcpy (waits for redroid healthy)
- **Stop Emulator**: Docker stop monitor (if running), scrcpy, then redroid. Sets `monitor_status = stopped`.
- **Start Monitor**: Docker start `monitor-cabinet-{id}` container. Sets `monitor_status = running`.
- **Stop Monitor**: Docker stop `monitor-cabinet-{id}` container. Sets `monitor_status = stopped`.

### Health Monitoring

Scheduler task (every 60s):
- For `status = running`: Docker inspect Redroid container. If dead → `status = error` with reason. Check `State.OOMKilled` specifically.
- For `monitor_status = running`: Check `last_heartbeat`. If > 120s stale → `monitor_status = error`.
- Optionally auto-restart crashed containers.

### Cleanup (Admin Delete)

1. Stop both containers (scrcpy first, then redroid)
2. Remove both containers
3. If `?removeVolume=true`: remove `emu-data-{cabinetId}` volume (frontend shows confirmation dialog)
4. Delete `emulator_instances` row
5. Delete generated ws-scrcpy config file
6. Regenerate nginx config, validate, reload

## 7. Order Data Flow

### Ingest Endpoint

```
POST /api/orders/ingest
Headers: X-Emulator-Key: {key}
Body: { "orders": [{ article, product, size, quantity, status, price, price_cents, date_raw, category, warehouse, arrival_city }] }
```

**Auth**: Bypasses JWT middleware (same skip list as `/api/auth/*`). Validates `X-Emulator-Key` against `emulator_instances.ingest_api_key`.

**Logic**:
1. Validate key → look up `cabinet_id`
2. Rate limit: max 1 request per 5s per key, max 100 orders per batch
3. For each order: build `dedup_key` = `article + size + status + date_raw`
4. `INSERT IGNORE INTO emu_orders` with `cabinet_id` scope
5. Return `{ inserted: N, duplicates: M }`

### Heartbeat Endpoint

```
POST /api/orders/heartbeat
Headers: X-Emulator-Key: {key}
```

Updates `emulator_instances.last_heartbeat = NOW()`. Same JWT bypass.

### Python Monitor

Stripped-down `wb_order_monitor.py` for container use:
- **Removed**: SQLite, Telegram bot, FastAPI server
- **Kept**: ADB connection, UI scraping loop, order parsing
- **Added**: HTTP POST to `INGEST_URL`, heartbeat every 30s to `HEARTBEAT_URL`, PID file at `/var/run/wb-monitor.pid`
- **Env vars**: `INGEST_URL`, `HEARTBEAT_URL`, `EMULATOR_KEY`, `CABINET_ID`

## 8. Monitor Script Deployment

Redroid images are pure Android (no GNU userspace, no apt-get, no Python). The Python monitor **cannot run inside the Redroid container**.

**Approach: Sidecar monitor container**

Instead of embedding the monitor in Redroid, run it as a third container per cabinet that connects to Redroid via ADB:

```
emu-cabinet-{id}      (Redroid — Android)
scrcpy-cabinet-{id}   (ws-scrcpy — web viewer)
monitor-cabinet-{id}  (Python — order scraper)
```

Monitor Dockerfile:
```dockerfile
FROM python:3.12-slim

RUN pip install --no-cache-dir uiautomator2 requests
RUN apt-get update && apt-get install -y --no-install-recommends adb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY wb-monitor/ /opt/wb-monitor/
WORKDIR /opt/wb-monitor
CMD ["python3", "run.py"]
```

Build: `docker build -t wb-emu-monitor:1.0 -f docker/wb-monitor/Dockerfile .`

The monitor container:
- Connects to Redroid via `adb connect 127.0.0.1:{adb_port}` (host network mode)
- Runs the scraping loop using uiautomator2 over ADB
- POSTs orders to the Bun ingest endpoint
- Sends heartbeats every 30s
- Writes PID file for lifecycle control
- Is NOT auto-started on creation — user triggers via "Start Monitor" button
- Uses `NetworkMode: host` to access the Redroid ADB port on localhost

Contents of `docker/wb-monitor/`:
- `run.py` — entry point: write PID file, connect ADB, scrape loop, POST orders, heartbeat thread
- `parser.py` — UI hierarchy XML parsing (extracted from wb_order_monitor.py)

## 9. Nginx Routing

### Generated Config

Orchestrator writes `/etc/nginx/conf.d/wb-emulators.conf` (included inside the `bidberry.animeenigma.ru` server block):

```nginx
# Auto-generated by EmulatorOrchestrator — do not edit

location /emu/3/ {
    auth_request /_auth/emu;
    error_page 401 =302 /;
    error_page 403 =302 /;

    add_header Content-Security-Policy "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ws: wss:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' ws: wss:; img-src 'self' blob: data:;";

    proxy_pass http://127.0.0.1:9092/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 86400s;
    proxy_buffering off;

    sub_filter_once off;
    sub_filter_types application/javascript;
    sub_filter '"/"+a)' '"/emu/3/"+a)';
}
```

The `sub_filter` fix is the same proven pattern from the current ws-scrcpy setup — rewrites `buildLink()` URLs to include the base path.

### Auth Endpoint

```
location = /_auth/emu {
    internal;
    proxy_pass http://127.0.0.1:3000/api/auth/check-emu;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Original-URI $request_uri;
}
```

Bun handler at `GET /api/auth/check-emu`:
1. Validate JWT from cookie
2. Extract instance ID from `X-Original-URI` (e.g., `/emu/3/...` → instance 3)
3. Verify user's cabinet has access to this instance
4. Return 200 or 403

### Config Lifecycle

- Atomic writes: write to `.tmp` → `nginx -t` → rename → `nginx -s reload`
- Generated on: instance create, instance delete
- The `include` directive is added inside the `bidberry.animeenigma.ru` server block in `/etc/nginx/sites-enabled/bidberry.animeenigma.ru`

## 10. Docker Engine API Integration

```typescript
// Bun fetch with unix socket (verified working on this host)
const dockerFetch = (path: string, options?: RequestInit) =>
  fetch(`http://localhost${path}`, { ...options, unix: '/var/run/docker.sock' });
```

Key operations:
- `POST /containers/create?name={name}` — create container
- `POST /containers/{id}/start` — start
- `POST /containers/{id}/stop` — stop
- `DELETE /containers/{id}?force=true` — remove
- `GET /containers/{id}/json` — inspect (health, state, OOM)
- `POST /containers/{id}/exec` + `POST /exec/{id}/start` — run monitor (detached)
- `GET /containers/{id}/logs?stdout=true&stderr=true&tail=100` — admin logs
- `GET /containers/json?filters={"label":["wb.managed=true"]}` — list managed
- `DELETE /volumes/{name}` — remove persistent data (admin cleanup)

## 11. Frontend

### Admin Panel (new "Emulators" tab in AdminPage)

- Table: cabinet name, status, monitor status, ADB port, scrcpy port, uptime
- "Create Emulator" → modal to select unassigned cabinet
- Per-row: delete (with volume removal confirmation), force-restart, view logs

### User Emulator Page (EmuPage.tsx, replaces EmuWebPage.tsx)

- `GET /api/emulators/mine` → user's cabinet emulator (if any)
- Status card: emulator status, monitor status, orders today, last order time, last heartbeat
- Control buttons: Start/Stop Emulator, Start/Stop Monitor
- Embedded ws-scrcpy iframe when running:
  ```html
  <iframe src="/emu/{instanceId}/" class="w-full h-[80vh] border-0" />
  ```
- No emulator assigned: "Contact admin to provision an emulator for your cabinet"

### Sidebar (AppSidebar.tsx)

- "Emulator" link visible to users with an assigned emulator
- "Emulators" in admin section

## 12. Observability

### Admin Logs

`GET /api/admin/emulators/:id/logs?tail=100` — proxies Docker `/containers/{id}/logs` for both redroid and scrcpy containers.

### Monitor Heartbeat

Python monitor → `POST /api/orders/heartbeat` every 30s. Health checker marks `error` if stale > 120s.

### Dashboard Metrics (EmuPage)

- Emulator uptime (Docker `State.StartedAt`)
- Monitor status + last heartbeat
- Orders today: `SELECT COUNT(*) FROM emu_orders WHERE cabinet_id = ? AND first_seen >= CURDATE()`
- Last order timestamp

## 13. Migration Plan

### Phase 1: Infrastructure
- Add `emulator_instances` and `emu_orders` tables to `init.sql`
- Build custom Redroid image (`wb-emu-redroid:14.0`)
- Implement EmulatorOrchestrator service
- Implement emulator repository

### Phase 2: API
- Admin emulator routes (CRUD)
- User emulator routes (start/stop/status)
- Order ingest + heartbeat endpoints (with JWT bypass)
- Nginx config generation + auth check endpoint

### Phase 3: Frontend
- Admin "Emulators" tab
- User EmuPage with iframe + controls
- Sidebar updates

### Phase 4: Migration
- Stop existing Redroid + ws-scrcpy containers
- Add `include /etc/nginx/conf.d/wb-emulators.conf;` to nginx server block
- Remove old `/emu-proxy/` location from nginx config
- Provision first emulator via new system
- Transfer WB Partners app state from old Redroid via ADB backup or volume copy

## 14. Files to Create/Modify

### New Files
- `src/services/emulator-orchestrator.ts` — Docker Engine API orchestration + nginx config gen
- `src/db/emulator-repository.ts` — CRUD for emulator_instances + emu_orders
- `src/web/emulator-admin-routes.ts` — Admin API
- `src/web/emulator-routes.ts` — User API
- `src/web/emulator-ingest-routes.ts` — Ingest + heartbeat (no JWT)
- `docker/wb-monitor/Dockerfile` — Python monitor sidecar image
- `docker/wb-monitor/run.py` — Order monitor entry point
- `docker/wb-monitor/parser.py` — UI parsing logic
- `public/app/components/emulator/EmuPage.tsx` — User emulator view
- `public/app/components/admin/EmulatorAdmin.tsx` — Admin management

### Modified Files
- `docker/init.sql` — Add `emulator_instances` and `emu_orders` tables
- `docker-compose.yml` — Add Docker socket + nginx config volume mounts to `wb-analytics-app`
- `src/index.ts` — Register emulator health check scheduler task, add `/emulator` SPA route
- `src/web/routes.ts` — Mount new route groups, JWT bypass for `/api/orders/*`
- `public/app/App.tsx` — Add EmuPage route
- `public/app/components/layout/AppSidebar.tsx` — Add emulator nav link
- `/etc/nginx/sites-enabled/bidberry.animeenigma.ru` — Add `include` + auth location, remove old `/emu-proxy/`

### Removed
- Old single-instance Redroid + ws-scrcpy from `WBPartners-Auto/docker-compose.yml`
- Old `/emu-proxy/` nginx location block + ws-scrcpy sub_filter rules
