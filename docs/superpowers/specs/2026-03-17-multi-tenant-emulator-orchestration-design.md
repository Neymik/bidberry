# Multi-Tenant Android Emulator Orchestration

**Date**: 2026-03-17
**Status**: Draft
**Scope**: Per-cabinet Android emulator instances with budtmo/docker-android, orchestrated by the Bun app via Docker Engine API

---

## 1. Problem Statement

The current WBPartners-Auto setup runs a single shared Redroid emulator for all users. As the platform scales to multiple users each with their own WB Partners seller account, each user needs an isolated Android emulator instance running the order monitor 24/7.

## 2. Requirements

- **Always-on**: Emulators run 24/7, surviving container restarts via persistent volumes
- **Scale**: 2-5 concurrent instances in the near term (single host)
- **Data flow**: Orders from each emulator feed into the existing MySQL database, scoped by `cabinet_id`
- **Access control**: Admin provisions emulator instances and assigns them to cabinets; users can start/stop/view their own assigned emulator
- **No Telegram**: Emulator layer only pushes data to MySQL via HTTP; dashboard handles all notifications
- **State persistence**: Android state (installed apps, logins) survives container restarts via Docker volumes
- **State import**: Support ADB backup/restore and volume mounting for transferring app state from local PCs
- **KVM required**: Host must have `/dev/kvm` available (budtmo/docker-android uses QEMU, not kernel-level like Redroid)
- **Host resources**: Minimum 4GB RAM + 2 CPU cores per emulator instance; 5 instances = 20GB RAM + 10 cores recommended

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Bun App (existing)                                 │
│  ├── /api/admin/emulators/*   (admin CRUD)          │
│  ├── /api/emulators/*         (user start/stop/view)│
│  ├── /emu/{instanceId}/       (noVNC proxy)         │
│  └── EmulatorOrchestrator     (Docker Engine API)   │
├─────────────────────────────────────────────────────┤
│  Docker Engine API (unix socket)                    │
│  ├── Container: emu-cabinet-3  (budtmo/docker-android)
│  │   ├── Android 14 emulator                        │
│  │   ├── noVNC on port 6082                         │
│  │   ├── ADB on port 5557                           │
│  │   ├── wb-monitor (Python, started separately)    │
│  │   └── Volume: emu-data-3 (/home/androidusr)      │
│  ├── Container: emu-cabinet-7  ...                  │
│  └── ...                                            │
├─────────────────────────────────────────────────────┤
│  Nginx (dynamic config)                             │
│  └── /emu/{id}/ → proxy_pass to container noVNC     │
│      (auth_request validates user access)            │
└─────────────────────────────────────────────────────┘
```

### Components

1. **EmulatorOrchestrator** (`src/services/emulator-orchestrator.ts`) — Communicates with Docker Engine API via unix socket (`/var/run/docker.sock`). Handles container lifecycle: create, start, stop, remove, inspect. Allocates ports dynamically. Generates nginx config and triggers reload. **Runs on the host** (not inside the Bun Docker container) — the Bun app process runs directly on the host via `bun run src/index.ts`, so it has native access to the Docker socket, nginx config directory, and `nginx -s reload`. No socket mounting or proxy needed.

2. **Emulator Admin Routes** (`src/web/emulator-admin-routes.ts`) — Admin-only CRUD: create instance for a cabinet, delete instance, list all instances, force-restart.

3. **Emulator User Routes** (`src/web/emulator-routes.ts`) — User-facing: start/stop emulator, start/stop monitor, get status, get noVNC URL.

4. **Order Ingest Endpoint** (`POST /api/orders/ingest`) — Receives order batches from the Python monitor inside each container. Authenticated via per-instance API key (bypasses JWT middleware). Upserts into a new `emu_orders` table (separate from the WB API `orders` table, since the schemas differ).

5. **Custom Docker Image** — Extends `budtmo/docker-android:emulator_14.0` with Python + the stripped-down monitor script (no SQLite, no Telegram).

6. **Emulator DB Repository** (`src/db/emulator-repository.ts`) — CRUD for the `emulator_instances` table.

## 4. Database Schema

```sql
CREATE TABLE emulator_instances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL UNIQUE,
  container_id VARCHAR(64),
  container_name VARCHAR(100) NOT NULL,
  status ENUM('created','running','stopped','error') DEFAULT 'created',
  monitor_status ENUM('stopped','running','error') DEFAULT 'stopped',
  novnc_port INT NOT NULL,
  adb_port INT NOT NULL,
  android_version VARCHAR(10) DEFAULT '14.0',
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

New table for emulator-sourced orders (schema differs from WB API `orders` table):

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

Key constraints for `emulator_instances`:
- `cabinet_id UNIQUE` — one emulator per cabinet
- `ingest_api_key` — generated via `crypto.getRandomValues(new Uint8Array(32))` converted to hex (64 chars), used by the Python monitor to authenticate against the ingest endpoint
- `monitor_status` — tracks the Python monitor process independently of the container status

## 5. Container Lifecycle

### Emulator States (user perspective)

| State | Emulator | Monitor | Transitions |
|-------|:--------:|:-------:|-------------|
| **Stopped** | off | off | → Start Emulator |
| **Running (setup)** | on | off | → Start Monitor (after app installed + logged in) |
| **Monitoring** | on | on | → Stop Monitor, Stop Emulator |
| **Error** | crashed | off | → Force Restart, Delete |

### Creation Flow

1. Admin calls `POST /api/admin/emulators` with `{ cabinetId }`
2. Orchestrator validates cabinet exists and has no existing emulator
3. Allocates next available ports: queries `emulator_instances` for used ports, picks lowest free in range (noVNC: 6080-6099, ADB: 5555-5574). Protected by MySQL transaction to prevent race conditions on concurrent creation.
4. Generates `ingest_api_key` via `crypto.getRandomValues(new Uint8Array(32))` → hex string
5. Calls Docker Engine API: create container with image, env vars, volume, port mappings, labels
6. Inserts row into `emulator_instances` with status `created`
7. Regenerates nginx upstream config, reloads nginx

### Container Configuration

```
Image: wb-android-monitor:14.0 (custom, extends budtmo/docker-android:emulator_14.0)
Environment:
  WEB_VNC=true
  APPIUM=false
  EMULATOR_DEVICE=Samsung Galaxy S10
  INGEST_URL=http://host.docker.internal:3000/api/orders/ingest
  EMULATOR_KEY={generated_api_key}
  CABINET_ID={cabinet_id}
HostConfig:
  ExtraHosts: ["host.docker.internal:host-gateway"]  # Required on Linux
  Devices: ["/dev/kvm:/dev/kvm"]                     # KVM pass-through for QEMU
  Memory: 4294967296    # 4GB limit per container
  NanoCpus: 2000000000  # 2 CPU cores limit
Volumes:
  emu-data-{cabinetId}:/home/androidusr  (persistent Android state)
Ports:
  {novnc_port}:6080  (noVNC)
  {adb_port}:5555    (ADB, needed for state import from local PC)
Labels:
  wb.cabinet_id={id}
  wb.managed=true
Restart: unless-stopped
```

### User Controls

- **Start Emulator**: `docker start {container_id}` → status = `running`
- **Stop Emulator**: `docker stop {container_id}` → status = `stopped`, monitor_status = `stopped`
- **Start Monitor**: `docker exec {container_id} python3 /opt/wb-monitor/run.py` (detached exec) → monitor_status = `running`. The monitor writes its PID to `/var/run/wb-monitor.pid` on startup.
- **Stop Monitor**: `docker exec {container_id} sh -c "kill $(cat /var/run/wb-monitor.pid)"` → monitor_status = `stopped`

### Health Monitoring

Scheduler task runs every 60 seconds:
- For each instance with status `running`: Docker inspect → check container is alive
- If container died: update status to `error` with exit reason
- For each instance with monitor_status `running`: check `last_heartbeat` timestamp in `emulator_instances`. The Python monitor POSTs a heartbeat to `POST /api/orders/heartbeat` every 30 seconds (same `X-Emulator-Key` auth). If last heartbeat > 120s ago, mark monitor_status = `error`.
- Optional auto-restart on crash (configurable)

### Cleanup

Admin deletes instance:
1. Stop container (if running)
2. Remove container
3. Prompt for volume removal (destroys app state — requires confirmation)
4. Delete `emulator_instances` row
5. Regenerate nginx config, reload

## 6. Order Data Flow

### Ingest Endpoint

```
POST /api/orders/ingest
Headers:
  X-Emulator-Key: {ingest_api_key}
Body:
  {
    "orders": [
      {
        "article": "123456",
        "product": "Футболка мужская",
        "size": "XL",
        "quantity": "1",
        "status": "Заказ",
        "price": "2 784 ₽",
        "price_cents": 278400,
        "date_raw": "9 мар, 19:05",
        "category": "Одежда",
        "warehouse": "Коледино",
        "arrival_city": "Москва"
      }
    ]
  }
```

**Auth bypass**: The ingest endpoint must be excluded from JWT middleware in `routes.ts`, since the Python monitor authenticates via `X-Emulator-Key`, not JWT. Add to the middleware skip list alongside `/api/auth/*`.

Handler logic:
1. Validate `X-Emulator-Key` against `emulator_instances.ingest_api_key`
2. Look up `cabinet_id` from the matching instance
3. For each order: upsert into `emu_orders` table with `cabinet_id` scope
4. Deduplication via composite key `dedup_key`: `article + size + status + date_raw` (includes `size` to distinguish same-article different-size orders at the same time)
5. Rate limit: max 1 request per 5 seconds per key, max 100 orders per batch
6. Return `{ inserted: N, duplicates: M }`

### Python Monitor Changes

The existing `wb_order_monitor.py` is stripped down for container use:
- **Removed**: SQLite (`db.py`), Telegram bot (`bot.py`), FastAPI server (`api.py`)
- **Kept**: ADB connection, UI scraping loop, order parsing logic
- **Added**: HTTP POST to `INGEST_URL` with batch of parsed orders
- **New env vars**: `INGEST_URL`, `EMULATOR_KEY`, `CABINET_ID`

## 7. Custom Docker Image

```dockerfile
FROM budtmo/docker-android:emulator_14.0

# Install Python dependencies for the monitor
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip && \
    pip3 install --no-cache-dir uiautomator2 requests && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy stripped-down monitor script
COPY wb-monitor/ /opt/wb-monitor/

# Monitor is NOT auto-started — triggered via docker exec
```

Build and tag: `wb-android-monitor:14.0`

Contents of `/opt/wb-monitor/`:
- `run.py` — entry point: connect ADB, scrape loop, POST orders to ingest URL
- `parser.py` — UI hierarchy parsing (extracted from wb_order_monitor.py)
- `requirements.txt` — uiautomator2, requests

## 8. Nginx Routing

### Dynamic Config Generation

Orchestrator generates `/etc/nginx/conf.d/wb-emulators.conf`:

```nginx
# Auto-generated by EmulatorOrchestrator — do not edit manually

location /emu/3/ {
    auth_request /_auth/emu;
    auth_request_set $auth_status $upstream_status;
    error_page 401 =302 /;
    error_page 403 =302 /;

    proxy_pass http://127.0.0.1:6082/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 86400s;
    proxy_buffering off;

    # Fix noVNC base path for assets, links, and WebSocket URLs
    sub_filter_once off;
    sub_filter_types text/html application/javascript;
    sub_filter 'href="/' 'href="/emu/3/';
    sub_filter 'src="/' 'src="/emu/3/';
    # noVNC WebSocket path: rewrite /websockify to /emu/{id}/websockify
    sub_filter '"websockify"' '"/emu/3/websockify"';
}

# Note: budtmo/docker-android's noVNC may support the --web parameter for base path.
# This should be tested during implementation. If supported, use the env var instead
# of sub_filter which is cleaner and handles all URL construction automatically.
```

### Auth Endpoint

```
GET /_auth/emu
```

Internal nginx auth_request. Bun checks:
1. Valid JWT in cookie/header
2. Extract emulator instance ID from `$request_uri`
3. Verify user has access to the instance's cabinet
4. Return 200 (allowed) or 403 (denied)

### Config Lifecycle

- Generated on: instance create, instance delete
- Included from main nginx config: `include /etc/nginx/conf.d/wb-emulators.conf;`
- Atomic writes: write to temp file (`wb-emulators.conf.tmp`), validate with `nginx -t`, then rename to final path. Only call `nginx -s reload` after validation passes. If validation fails, log error and keep previous config.

## 9. Frontend Changes

### Admin Panel (AdminPage.tsx — new "Emulators" tab)

- Table: all emulator instances with cabinet name, status, monitor status, ports, uptime
- "Create Emulator" button → modal to select unassigned cabinet
- Per-row actions: delete (with volume removal confirmation), force-restart

### User Emulator Page (EmuPage.tsx — replaces EmuWebPage.tsx)

- Fetches `GET /api/emulators/mine` → returns user's cabinet emulator (if any)
- Status card: emulator status, monitor status, orders today, last order time
- Control buttons:
  - Start / Stop Emulator
  - Start / Stop Monitor (only when emulator is running)
- Embedded noVNC iframe (shown when emulator is running):
  ```html
  <iframe src="/emu/{instanceId}/" style="width:100%;height:80vh;border:none;" />
  ```
- If no emulator assigned: "Contact admin to set up your emulator"

### Sidebar Update (AppSidebar.tsx)

- Add "Emulator" link (visible to all users who have an assigned emulator)
- Admin section: "Emulators" under admin menu

## 10. Docker Engine API Integration

Communication via unix socket — no Docker SDK needed. Bun's `fetch` supports unix sockets natively via the `unix` option (verified on the target host).

### Key Operations

```typescript
// Base: fetch to Docker Engine API via unix socket
const dockerFetch = (path: string, options?: RequestInit) =>
  fetch(`http://localhost${path}`, { ...options, unix: '/var/run/docker.sock' });

// Create container
POST /containers/create?name=emu-cabinet-{id}
Body: { Image, Env, HostConfig: { Binds, PortBindings }, Labels }

// Start container
POST /containers/{id}/start

// Stop container
POST /containers/{id}/stop

// Remove container
DELETE /containers/{id}?force=true

// Inspect container
GET /containers/{id}/json

// Exec (start monitor)
POST /containers/{id}/exec
Body: { Cmd: ["python3", "/opt/wb-monitor/run.py"], Detach: true }
POST /exec/{execId}/start
Body: { Detach: true }

// List managed containers
GET /containers/json?filters={"label":["wb.managed=true"]}
```

## 11. Migration Plan

### Phase 1: Infrastructure
- Create `emulator_instances` table
- Build custom Docker image (wb-android-monitor:14.0)
- Implement EmulatorOrchestrator service
- Implement emulator repository

### Phase 2: API
- Admin emulator routes (CRUD)
- User emulator routes (start/stop/status)
- Order ingest endpoint
- Nginx config generation + auth endpoint

### Phase 3: Frontend
- Admin "Emulators" tab
- User EmuPage with noVNC iframe + controls
- Sidebar updates

### Phase 4: Migration
- Stop existing Redroid + ws-scrcpy containers
- Remove old WBPartners-Auto docker-compose services
- Provision first emulator instance via new system
- Transfer WB Partners app state from old Redroid (ADB backup/restore or volume copy)

## 12. Files to Create/Modify

### New Files
- `src/services/emulator-orchestrator.ts` — Docker Engine API orchestration
- `src/db/emulator-repository.ts` — CRUD for emulator_instances
- `src/web/emulator-admin-routes.ts` — Admin API endpoints
- `src/web/emulator-routes.ts` — User API endpoints
- `docker/wb-monitor/Dockerfile` — Custom image extending budtmo/docker-android
- `docker/wb-monitor/run.py` — Stripped-down order monitor
- `docker/wb-monitor/parser.py` — UI parsing logic
- `public/app/components/emulator/EmuPage.tsx` — User emulator view
- `public/app/components/admin/EmulatorAdmin.tsx` — Admin emulator management

### Modified Files
- `docker/init.sql` — Add `emulator_instances` and `emu_orders` tables
- `src/index.ts` — Register emulator health check scheduler task
- `src/web/routes.ts` — Mount new route groups
- `public/app/App.tsx` — Add EmuPage route
- `public/app/components/layout/AppSidebar.tsx` — Add emulator nav link
- `/etc/nginx/sites-enabled/bidberry.animeenigma.ru` — Include emulator config, add auth endpoint

### Removed
- `WBPartners-Auto/docker-compose.yml` services (redroid, scrcpy-web) — replaced by orchestrated budtmo containers
- `/etc/nginx/sites-enabled/bidberry.animeenigma.ru` `/emu-proxy/` location — replaced by dynamic `/emu/{id}/` locations

## 13. Observability

### Admin Logs Endpoint

`GET /api/admin/emulators/:id/logs?tail=100` — proxies Docker Engine API `/containers/{id}/logs` to the admin panel. Returns stdout/stderr from the emulator container including the Python monitor output.

### Monitor Heartbeat

The Python monitor POSTs to `POST /api/orders/heartbeat` every 30 seconds with its `X-Emulator-Key`. The Bun app updates `emulator_instances.last_heartbeat`. The health check scheduler marks monitor as `error` if heartbeat is stale (>120s).

### Dashboard Metrics (per emulator)

Displayed on the user's EmuPage:
- Emulator uptime (from Docker inspect `State.StartedAt`)
- Monitor status + last heartbeat
- Orders ingested today (count from `emu_orders WHERE first_seen > TODAY`)
- Last order timestamp
