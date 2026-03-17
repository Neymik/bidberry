# Multi-Tenant Emulator Orchestration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-cabinet Redroid emulator instances with ws-scrcpy web viewer and Python monitor sidecar, orchestrated via Docker Engine API from the Bun app.

**Architecture:** Three containers per cabinet (Redroid + ws-scrcpy + Python monitor) managed by an EmulatorOrchestrator service that talks to Docker Engine API via unix socket. Orders flow from the monitor to MySQL via an HTTP ingest endpoint. Nginx routes per-instance ws-scrcpy viewers with JWT-based auth.

**Tech Stack:** Bun/Hono (API), MySQL (data), Docker Engine API (orchestration), Redroid (Android), ws-scrcpy (web viewer), Python/uiautomator2 (monitor), Nginx (routing)

**Spec:** `docs/superpowers/specs/2026-03-17-redroid-multi-tenant-emulator-design.md`

---

## Chunk 1: Database + Repository + Docker Compose

### Task 1: Add database tables

**Files:**
- Modify: `docker/init.sql` (append after line 525)

- [ ] **Step 1: Add `emulator_instances` and `emu_orders` tables to init.sql**

Append to the end of `docker/init.sql`:

```sql
-- Emulator instance management
CREATE TABLE IF NOT EXISTS emulator_instances (
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

-- Orders scraped from emulator (different schema from WB API orders table)
CREATE TABLE IF NOT EXISTS emu_orders (
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

- [ ] **Step 2: Apply migration to running database**

```bash
docker exec -i wb-analytics-mysql mysql -uwb_user -pwb_s3cur3_p@ss2024 wb_analytics < docker/init.sql
```

Expected: Tables created (no errors, `IF NOT EXISTS` makes it idempotent).

- [ ] **Step 3: Verify tables exist**

```bash
docker exec wb-analytics-mysql mysql -uwb_user -pwb_s3cur3_p@ss2024 wb_analytics -e "SHOW TABLES LIKE 'emu%'; SHOW TABLES LIKE 'emulator%';"
```

Expected: `emu_orders` and `emulator_instances` listed.

- [ ] **Step 4: Commit**

```bash
git add docker/init.sql
git commit -m "feat: add emulator_instances and emu_orders tables"
```

---

### Task 2: Emulator repository

**Files:**
- Create: `src/db/emulator-repository.ts`

- [ ] **Step 1: Write the emulator repository**

Follow the pattern from `src/db/cabinets-repository.ts` (imports `query`, `execute` from `./connection`).

```typescript
import { query, execute, transaction } from './connection';

// Types
export interface EmulatorInstance {
  id: number;
  cabinet_id: number;
  emu_container_id: string | null;
  scrcpy_container_id: string | null;
  monitor_container_id: string | null;
  emu_container_name: string;
  scrcpy_container_name: string;
  monitor_container_name: string;
  status: 'created' | 'running' | 'stopped' | 'error';
  monitor_status: 'stopped' | 'running' | 'error';
  adb_port: number;
  scrcpy_port: number;
  ingest_api_key: string;
  last_heartbeat: Date | null;
  error_message: string | null;
  created_by: number;
  created_at: Date;
  updated_at: Date;
}

export interface EmuOrder {
  id: number;
  cabinet_id: number;
  dedup_key: string;
  article: string;
  product: string | null;
  size: string | null;
  quantity: string | null;
  status: string | null;
  price: string | null;
  price_cents: number | null;
  date_raw: string | null;
  date_parsed: Date | null;
  category: string | null;
  warehouse: string | null;
  arrival_city: string | null;
  first_seen: Date;
}

// Port allocation ranges
const ADB_PORT_MIN = 5555;
const ADB_PORT_MAX = 5574;
const SCRCPY_PORT_MIN = 9090;
const SCRCPY_PORT_MAX = 9109;

// === Emulator Instances ===

export async function getAllInstances(): Promise<EmulatorInstance[]> {
  return query<EmulatorInstance[]>('SELECT * FROM emulator_instances ORDER BY id');
}

export async function getInstanceById(id: number): Promise<EmulatorInstance | null> {
  const rows = await query<EmulatorInstance[]>('SELECT * FROM emulator_instances WHERE id = ?', [id]);
  return rows[0] ?? null;
}

export async function getInstanceByCabinetId(cabinetId: number): Promise<EmulatorInstance | null> {
  const rows = await query<EmulatorInstance[]>('SELECT * FROM emulator_instances WHERE cabinet_id = ?', [cabinetId]);
  return rows[0] ?? null;
}

export async function getInstanceByApiKey(apiKey: string): Promise<EmulatorInstance | null> {
  const rows = await query<EmulatorInstance[]>('SELECT * FROM emulator_instances WHERE ingest_api_key = ?', [apiKey]);
  return rows[0] ?? null;
}

export async function getRunningInstances(): Promise<EmulatorInstance[]> {
  return query<EmulatorInstance[]>("SELECT * FROM emulator_instances WHERE status = 'running'");
}

export async function allocatePortsAndCreate(
  cabinetId: number,
  createdBy: number,
  ingestApiKey: string
): Promise<EmulatorInstance> {
  return transaction(async (conn) => {
    const [usedRows] = await conn.query('SELECT adb_port, scrcpy_port FROM emulator_instances FOR UPDATE');
    const used = usedRows as { adb_port: number; scrcpy_port: number }[];
    const usedAdb = new Set(used.map(r => r.adb_port));
    const usedScrcpy = new Set(used.map(r => r.scrcpy_port));

    let adbPort = 0;
    for (let p = ADB_PORT_MIN; p <= ADB_PORT_MAX; p++) {
      if (!usedAdb.has(p)) { adbPort = p; break; }
    }
    let scrcpyPort = 0;
    for (let p = SCRCPY_PORT_MIN; p <= SCRCPY_PORT_MAX; p++) {
      if (!usedScrcpy.has(p)) { scrcpyPort = p; break; }
    }

    if (!adbPort || !scrcpyPort) throw new Error('No free ports available');

    const emuName = `emu-cabinet-${cabinetId}`;
    const scrcpyName = `scrcpy-cabinet-${cabinetId}`;
    const monitorName = `monitor-cabinet-${cabinetId}`;

    const [result] = await conn.execute(
      `INSERT INTO emulator_instances
        (cabinet_id, emu_container_name, scrcpy_container_name, monitor_container_name,
         adb_port, scrcpy_port, ingest_api_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cabinetId, emuName, scrcpyName, monitorName, adbPort, scrcpyPort, ingestApiKey, createdBy]
    );

    const insertId = (result as any).insertId;
    const inst = await query<EmulatorInstance[]>('SELECT * FROM emulator_instances WHERE id = ?', [insertId]);
    return inst[0];
  });
}

export async function updateContainerIds(
  id: number,
  emuContainerId: string,
  scrcpyContainerId: string,
  monitorContainerId: string
): Promise<void> {
  await execute(
    `UPDATE emulator_instances
     SET emu_container_id = ?, scrcpy_container_id = ?, monitor_container_id = ?
     WHERE id = ?`,
    [emuContainerId, scrcpyContainerId, monitorContainerId, id]
  );
}

export async function updateStatus(id: number, status: string, errorMessage?: string): Promise<void> {
  await execute(
    'UPDATE emulator_instances SET status = ?, error_message = ? WHERE id = ?',
    [status, errorMessage ?? null, id]
  );
}

export async function updateMonitorStatus(id: number, monitorStatus: string): Promise<void> {
  await execute(
    'UPDATE emulator_instances SET monitor_status = ? WHERE id = ?',
    [monitorStatus, id]
  );
}

export async function updateHeartbeat(id: number): Promise<void> {
  await execute('UPDATE emulator_instances SET last_heartbeat = NOW() WHERE id = ?', [id]);
}

export async function deleteInstance(id: number): Promise<void> {
  await execute('DELETE FROM emulator_instances WHERE id = ?', [id]);
}

// === Emu Orders ===

export async function insertOrders(
  cabinetId: number,
  orders: Array<{
    article: string; product?: string; size?: string; quantity?: string;
    status?: string; price?: string; price_cents?: number;
    date_raw?: string; date_parsed?: Date; category?: string;
    warehouse?: string; arrival_city?: string;
  }>
): Promise<{ inserted: number; duplicates: number }> {
  let inserted = 0;
  let duplicates = 0;

  for (const o of orders) {
    const dedupKey = `${o.article}|${o.size ?? ''}|${o.status ?? ''}|${o.date_raw ?? ''}`;
    try {
      const result = await execute(
        `INSERT IGNORE INTO emu_orders
          (cabinet_id, dedup_key, article, product, size, quantity, status, price, price_cents, date_raw, date_parsed, category, warehouse, arrival_city)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cabinetId, dedupKey, o.article, o.product ?? null, o.size ?? null, o.quantity ?? null,
         o.status ?? null, o.price ?? null, o.price_cents ?? null, o.date_raw ?? null,
         o.date_parsed ?? null, o.category ?? null, o.warehouse ?? null, o.arrival_city ?? null]
      );
      if ((result as any).affectedRows > 0) inserted++;
      else duplicates++;
    } catch {
      duplicates++;
    }
  }

  return { inserted, duplicates };
}

export async function getEmuOrdersToday(cabinetId: number): Promise<number> {
  const rows = await query<any[]>(
    'SELECT COUNT(*) as cnt FROM emu_orders WHERE cabinet_id = ? AND first_seen >= CURDATE()',
    [cabinetId]
  );
  return rows[0].cnt;
}

export async function getLastEmuOrder(cabinetId: number): Promise<Date | null> {
  const rows = await query<any[]>(
    'SELECT first_seen FROM emu_orders WHERE cabinet_id = ? ORDER BY first_seen DESC LIMIT 1',
    [cabinetId]
  );
  return rows[0]?.first_seen ?? null;
}
```

- [ ] **Step 2: Verify repository compiles**

```bash
docker exec wb-analytics-app bun run --bun src/db/emulator-repository.ts 2>&1 | head -5
```

Expected: No syntax errors (may fail at runtime without proper imports — that's OK).

- [ ] **Step 3: Commit**

```bash
git add src/db/emulator-repository.ts
git commit -m "feat: add emulator instance and emu_orders repository"
```

---

### Task 3: Mount Docker socket in docker-compose.yml

**Files:**
- Modify: `docker-compose.yml` (app service volumes, around line 50-51)

- [ ] **Step 1: Add Docker socket + nginx config mounts**

In `docker-compose.yml`, add to the `app` service `volumes` section:

```yaml
    volumes:
      - ./exports:/app/exports
      - /var/run/docker.sock:/var/run/docker.sock
      - /etc/nginx/conf.d:/etc/nginx-conf
      - /etc/wb-emulators:/etc/wb-emulators
```

- [ ] **Step 2: Create the persistent config directory on host**

```bash
mkdir -p /etc/wb-emulators
```

- [ ] **Step 3: Rebuild and restart app container**

```bash
docker compose up -d --build
```

- [ ] **Step 4: Verify socket is accessible from inside container**

```bash
docker exec wb-analytics-app ls -la /var/run/docker.sock
```

Expected: `srw-rw----` socket file listed.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: mount Docker socket and nginx config into app container"
```

---

## Chunk 2: Emulator Orchestrator Service

### Task 4: Docker Engine API client

**Files:**
- Create: `src/services/docker-client.ts`

- [ ] **Step 1: Write the Docker Engine API wrapper**

```typescript
// Thin wrapper over Docker Engine API via unix socket

const DOCKER_SOCKET = '/var/run/docker.sock';

async function dockerFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...options,
    // @ts-ignore — Bun supports unix socket option
    unix: DOCKER_SOCKET,
  });
}

export interface ContainerCreateOptions {
  Image: string;
  Cmd?: string[];
  Env?: string[];
  Entrypoint?: string[];
  HostConfig?: {
    Privileged?: boolean;
    Binds?: string[];
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort: string }>>;
    NetworkMode?: string;
    Memory?: number;
    NanoCpus?: number;
    RestartPolicy?: { Name: string };
  };
  Labels?: Record<string, string>;
  Healthcheck?: {
    Test: string[];
    Interval: number;
    Timeout: number;
    Retries: number;
    StartPeriod: number;
  };
}

export interface ContainerInspect {
  Id: string;
  State: {
    Status: string;
    Running: boolean;
    OOMKilled: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string };
  };
  Name: string;
}

export async function createContainer(name: string, config: ContainerCreateOptions): Promise<string> {
  const res = await dockerFetch(`/containers/create?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Docker create failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { Id: string };
  return data.Id;
}

export async function startContainer(id: string): Promise<void> {
  const res = await dockerFetch(`/containers/${id}/start`, { method: 'POST' });
  if (!res.ok && res.status !== 304) { // 304 = already started
    throw new Error(`Docker start failed (${res.status}): ${await res.text()}`);
  }
}

export async function stopContainer(id: string, timeout = 30): Promise<void> {
  const res = await dockerFetch(`/containers/${id}/stop?t=${timeout}`, { method: 'POST' });
  if (!res.ok && res.status !== 304) { // 304 = already stopped
    throw new Error(`Docker stop failed (${res.status}): ${await res.text()}`);
  }
}

export async function removeContainer(id: string, force = true): Promise<void> {
  const res = await dockerFetch(`/containers/${id}?force=${force}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Docker remove failed (${res.status}): ${await res.text()}`);
  }
}

export async function inspectContainer(id: string): Promise<ContainerInspect> {
  const res = await dockerFetch(`/containers/${id}/json`);
  if (!res.ok) throw new Error(`Docker inspect failed (${res.status})`);
  return res.json() as Promise<ContainerInspect>;
}

export async function getContainerLogs(id: string, tail = 100): Promise<string> {
  const res = await dockerFetch(`/containers/${id}/logs?stdout=true&stderr=true&tail=${tail}&timestamps=true`);
  if (!res.ok) throw new Error(`Docker logs failed (${res.status})`);
  // Docker logs have 8-byte header per line, strip it
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const lines: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (i + 8 > bytes.length) break;
    const size = (bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7];
    i += 8;
    if (i + size > bytes.length) break;
    lines.push(new TextDecoder().decode(bytes.slice(i, i + size)));
    i += size;
  }
  return lines.join('');
}

export async function removeVolume(name: string): Promise<void> {
  const res = await dockerFetch(`/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Docker volume remove failed (${res.status}): ${await res.text()}`);
  }
}

export async function listManagedContainers(): Promise<Array<{ Id: string; Names: string[]; State: string; Labels: Record<string, string> }>> {
  const filters = JSON.stringify({ label: ['wb.managed=true'] });
  const res = await dockerFetch(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);
  if (!res.ok) throw new Error(`Docker list failed (${res.status})`);
  return res.json() as Promise<any[]>;
}
```

- [ ] **Step 2: Verify it compiles inside the container**

```bash
docker exec wb-analytics-app bun run --bun src/services/docker-client.ts 2>&1 | head -5
```

- [ ] **Step 3: Quick smoke test — list containers from inside the app container**

```bash
docker exec wb-analytics-app bun -e "
  const r = await fetch('http://localhost/containers/json?limit=3', { unix: '/var/run/docker.sock' });
  const d = await r.json();
  console.log('OK, containers:', d.length);
"
```

Expected: `OK, containers: N` (proves socket access works from inside the container).

- [ ] **Step 4: Commit**

```bash
git add src/services/docker-client.ts
git commit -m "feat: add Docker Engine API client via unix socket"
```

---

### Task 5: Emulator Orchestrator service

**Files:**
- Create: `src/services/emulator-orchestrator.ts`

- [ ] **Step 1: Write the orchestrator**

This is the core service. It uses the Docker client and the emulator repository to manage container trios.

```typescript
import * as docker from './docker-client';
import * as emuRepo from '../db/emulator-repository';

const REDROID_IMAGE = 'redroid/redroid:14.0.0-latest';
const SCRCPY_IMAGE = 'scavin/ws-scrcpy:latest';
const MONITOR_IMAGE = 'wb-emu-monitor:1.0';
const BUN_APP_PORT = process.env.APP_PORT || '3000';

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// === Provisioning ===

export async function provisionEmulator(cabinetId: number, createdBy: number) {
  // 1. Allocate ports + insert DB row (atomic)
  const apiKey = generateApiKey();
  const instance = await emuRepo.allocatePortsAndCreate(cabinetId, createdBy, apiKey);

  try {
    // 2. Create Redroid container
    const emuId = await docker.createContainer(instance.emu_container_name, {
      Image: REDROID_IMAGE,
      Cmd: [
        'androidboot.redroid_width=1080',
        'androidboot.redroid_height=1920',
        'androidboot.redroid_dpi=440',
        'androidboot.redroid_fps=15',
        'androidboot.redroid_gpu_mode=guest',
        'androidboot.use_memfd=true',
      ],
      HostConfig: {
        Privileged: true,
        Binds: [`emu-data-${cabinetId}:/data`],
        PortBindings: {
          '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: String(instance.adb_port) }],
        },
        Memory: 1610612736, // 1.5GB
        NanoCpus: 2000000000, // 2 cores
        RestartPolicy: { Name: 'unless-stopped' },
      },
      Labels: {
        'wb.cabinet_id': String(cabinetId),
        'wb.managed': 'true',
        'wb.type': 'redroid',
      },
      Healthcheck: {
        Test: ['CMD-SHELL', 'getprop sys.boot_completed | grep -q 1'],
        Interval: 10_000_000_000,
        Timeout: 5_000_000_000,
        Retries: 30,
        StartPeriod: 60_000_000_000,
      },
    });

    // 3. Generate ws-scrcpy config file
    const scrcpyConfigPath = `/etc/wb-emulators/ws-scrcpy-${cabinetId}.yaml`;
    const scrcpyConfig = `runGoogTracker: true\nannounceGoogTracker: true\nserver:\n  - secure: false\n    port: ${instance.scrcpy_port}\n`;
    await Bun.write(scrcpyConfigPath, scrcpyConfig);

    // 4. Create ws-scrcpy container
    const scrcpyId = await docker.createContainer(instance.scrcpy_container_name, {
      Image: SCRCPY_IMAGE,
      Env: ['WS_SCRCPY_CONFIG=/ws-scrcpy/config.yaml'],
      Entrypoint: ['/bin/bash'],
      Cmd: ['-c', `adb connect 127.0.0.1:${instance.adb_port} && sleep 3 && npm start`],
      HostConfig: {
        NetworkMode: 'host',
        Binds: [`${scrcpyConfigPath}:/ws-scrcpy/config.yaml:ro`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      Labels: {
        'wb.cabinet_id': String(cabinetId),
        'wb.managed': 'true',
        'wb.type': 'scrcpy',
      },
    });

    // 5. Create monitor container (not started)
    const monitorId = await docker.createContainer(instance.monitor_container_name, {
      Image: MONITOR_IMAGE,
      Env: [
        `ADB_DEVICE=127.0.0.1:${instance.adb_port}`,
        `INGEST_URL=http://127.0.0.1:${BUN_APP_PORT}/api/orders/ingest`,
        `HEARTBEAT_URL=http://127.0.0.1:${BUN_APP_PORT}/api/orders/heartbeat`,
        `EMULATOR_KEY=${apiKey}`,
        `CABINET_ID=${cabinetId}`,
      ],
      HostConfig: {
        NetworkMode: 'host',
        Memory: 268435456, // 256MB
        NanoCpus: 500000000, // 0.5 cores
        RestartPolicy: { Name: 'no' },
      },
      Labels: {
        'wb.cabinet_id': String(cabinetId),
        'wb.managed': 'true',
        'wb.type': 'monitor',
      },
    });

    // 6. Update DB with container IDs
    await emuRepo.updateContainerIds(instance.id, emuId, scrcpyId, monitorId);

    // 7. Regenerate nginx config
    await regenerateNginxConfig();

    return await emuRepo.getInstanceById(instance.id);
  } catch (err) {
    // Cleanup on failure
    await emuRepo.deleteInstance(instance.id);
    // Try to remove any created containers
    try { await docker.removeContainer(instance.emu_container_name); } catch {}
    try { await docker.removeContainer(instance.scrcpy_container_name); } catch {}
    try { await docker.removeContainer(instance.monitor_container_name); } catch {}
    throw err;
  }
}

// === Lifecycle ===

export async function startEmulator(instanceId: number) {
  const inst = await emuRepo.getInstanceById(instanceId);
  if (!inst) throw new Error('Instance not found');

  await docker.startContainer(inst.emu_container_id!);

  // Wait for redroid to be healthy (poll up to 90s)
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const info = await docker.inspectContainer(inst.emu_container_id!);
      if (info.State.Health?.Status === 'healthy') break;
    } catch {}
  }

  await docker.startContainer(inst.scrcpy_container_id!);
  await emuRepo.updateStatus(instanceId, 'running');
}

export async function stopEmulator(instanceId: number) {
  const inst = await emuRepo.getInstanceById(instanceId);
  if (!inst) throw new Error('Instance not found');

  // Stop monitor first if running
  if (inst.monitor_status === 'running' && inst.monitor_container_id) {
    try { await docker.stopContainer(inst.monitor_container_id, 10); } catch {}
    await emuRepo.updateMonitorStatus(instanceId, 'stopped');
  }

  // Stop scrcpy, then redroid
  if (inst.scrcpy_container_id) {
    try { await docker.stopContainer(inst.scrcpy_container_id, 5); } catch {}
  }
  if (inst.emu_container_id) {
    await docker.stopContainer(inst.emu_container_id, 30);
  }

  await emuRepo.updateStatus(instanceId, 'stopped');
}

export async function startMonitor(instanceId: number) {
  const inst = await emuRepo.getInstanceById(instanceId);
  if (!inst || inst.status !== 'running') throw new Error('Emulator must be running first');
  if (!inst.monitor_container_id) throw new Error('Monitor container not found');

  await docker.startContainer(inst.monitor_container_id);
  await emuRepo.updateMonitorStatus(instanceId, 'running');
}

export async function stopMonitor(instanceId: number) {
  const inst = await emuRepo.getInstanceById(instanceId);
  if (!inst || !inst.monitor_container_id) throw new Error('Instance not found');

  try { await docker.stopContainer(inst.monitor_container_id, 10); } catch {}
  await emuRepo.updateMonitorStatus(instanceId, 'stopped');
}

export async function deleteEmulator(instanceId: number, removeVolume = false) {
  const inst = await emuRepo.getInstanceById(instanceId);
  if (!inst) throw new Error('Instance not found');

  // Stop and remove all containers
  for (const cid of [inst.monitor_container_id, inst.scrcpy_container_id, inst.emu_container_id]) {
    if (cid) {
      try { await docker.stopContainer(cid, 10); } catch {}
      try { await docker.removeContainer(cid); } catch {}
    }
  }

  if (removeVolume) {
    try { await docker.removeVolume(`emu-data-${inst.cabinet_id}`); } catch {}
  }

  // Clean up config file
  try { await Bun.file(`/etc/wb-emulators/ws-scrcpy-${inst.cabinet_id}.yaml`).exists() && await Bun.$`rm /etc/wb-emulators/ws-scrcpy-${inst.cabinet_id}.yaml`; } catch {}

  await emuRepo.deleteInstance(instanceId);
  await regenerateNginxConfig();
}

// === Health Check ===

export async function healthCheck() {
  const instances = await emuRepo.getAllInstances();

  for (const inst of instances) {
    // Check running emulators
    if (inst.status === 'running' && inst.emu_container_id) {
      try {
        const info = await docker.inspectContainer(inst.emu_container_id);
        if (!info.State.Running) {
          const reason = info.State.OOMKilled ? 'OOM killed' : `Exited (${info.State.ExitCode})`;
          await emuRepo.updateStatus(inst.id, 'error', reason);
          await emuRepo.updateMonitorStatus(inst.id, 'stopped');
        }
      } catch {
        await emuRepo.updateStatus(inst.id, 'error', 'Container not found');
      }
    }

    // Check monitor heartbeat
    if (inst.monitor_status === 'running' && inst.last_heartbeat) {
      const staleMs = Date.now() - new Date(inst.last_heartbeat).getTime();
      if (staleMs > 120_000) {
        await emuRepo.updateMonitorStatus(inst.id, 'error');
      }
    }

    // Check orphaned 'created' rows (no container IDs after 5 min)
    if (inst.status === 'created' && !inst.emu_container_id) {
      const ageMs = Date.now() - new Date(inst.created_at).getTime();
      if (ageMs > 300_000) {
        await emuRepo.deleteInstance(inst.id);
      }
    }
  }
}

// === Nginx Config ===

export async function regenerateNginxConfig() {
  const instances = await emuRepo.getAllInstances();
  let config = '# Auto-generated by EmulatorOrchestrator — do not edit\n\n';

  for (const inst of instances) {
    config += `location /emu/${inst.id}/ {
    auth_request /_auth/emu;
    error_page 401 =302 /;
    error_page 403 =302 /;

    add_header Content-Security-Policy "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ws: wss:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' ws: wss:; img-src 'self' blob: data:;";

    proxy_pass http://127.0.0.1:${inst.scrcpy_port}/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 86400s;
    proxy_buffering off;

    sub_filter_once off;
    sub_filter_types application/javascript;
    sub_filter '"/"+a)' '"/emu/${inst.id}/"+a)';
}\n\n`;
  }

  // Atomic write: tmp -> validate -> rename -> reload
  const tmpPath = '/etc/nginx-conf/wb-emulators.conf.tmp';
  const finalPath = '/etc/nginx-conf/wb-emulators.conf';

  await Bun.write(tmpPath, config);

  // Rename tmp to final (atomic on same filesystem)
  const fs = await import('node:fs/promises');
  await fs.rename(tmpPath, finalPath);
  // Trigger nginx reload on host via docker exec (Bun runs inside wb-analytics-app container)
  try {
    await fetch('http://localhost/containers/json?limit=1', { unix: '/var/run/docker.sock' }); // verify socket
    // Find host PID 1's nginx and reload it via nsenter, or use a simpler approach:
    // Write a trigger file that a host-side watcher picks up
    await Bun.write('/etc/nginx-conf/.reload-trigger', String(Date.now()));
  } catch (err) {
    console.error('[EmulatorOrchestrator] nginx reload trigger failed:', err);
  }
}
```

> **Note:** Nginx reload requires a host-side file watcher. Create a systemd service or cron job on the host that watches `/etc/nginx/conf.d/.reload-trigger` and runs `nginx -t && nginx -s reload`. Example: `inotifywait -m /etc/nginx/conf.d/.reload-trigger -e modify | while read; do nginx -t && nginx -s reload; done`

- [ ] **Step 2: Commit**

```bash
git add src/services/emulator-orchestrator.ts
git commit -m "feat: add EmulatorOrchestrator with Docker lifecycle management"
```

---

## Chunk 3: API Routes (Admin + User + Ingest)

### Task 6: Ingest + heartbeat routes (no JWT)

**Files:**
- Create: `src/web/emulator-ingest-routes.ts`
- Modify: `src/web/routes.ts` (add JWT bypass + mount)

- [ ] **Step 1: Write ingest routes**

```typescript
import { Hono } from 'hono';
import * as emuRepo from '../db/emulator-repository';

const app = new Hono();

// Rate limit: in-memory map, max 1 req per 5s per key
const lastRequest = new Map<string, number>();

app.post('/ingest', async (c) => {
  const apiKey = c.req.header('X-Emulator-Key');
  if (!apiKey) return c.json({ error: 'Missing X-Emulator-Key' }, 401);

  const instance = await emuRepo.getInstanceByApiKey(apiKey);
  if (!instance) return c.json({ error: 'Invalid key' }, 401);

  // Rate limit
  const now = Date.now();
  const last = lastRequest.get(apiKey) ?? 0;
  if (now - last < 5000) return c.json({ error: 'Rate limited' }, 429);
  lastRequest.set(apiKey, now);

  const body = await c.req.json<{ orders?: any[] }>();
  if (!body.orders || !Array.isArray(body.orders)) return c.json({ error: 'Invalid body' }, 400);
  if (body.orders.length > 100) return c.json({ error: 'Max 100 orders per batch' }, 400);

  const result = await emuRepo.insertOrders(instance.cabinet_id, body.orders);
  return c.json(result);
});

app.post('/heartbeat', async (c) => {
  const apiKey = c.req.header('X-Emulator-Key');
  if (!apiKey) return c.json({ error: 'Missing X-Emulator-Key' }, 401);

  const instance = await emuRepo.getInstanceByApiKey(apiKey);
  if (!instance) return c.json({ error: 'Invalid key' }, 401);

  await emuRepo.updateHeartbeat(instance.id);
  return c.json({ ok: true });
});

export default app;
```

- [ ] **Step 2: Add JWT bypass in routes.ts**

In `src/web/routes.ts`, find the auth skip condition (around line 34-36) and extend it:

```typescript
// Before:
if (c.req.path.startsWith('/api/auth/')) return next();

// After:
if (c.req.path.startsWith('/api/auth/') ||
    c.req.path === '/api/orders/ingest' ||
    c.req.path === '/api/orders/heartbeat') return next();
```

- [ ] **Step 3: Mount ingest routes in routes.ts**

Add import and mount alongside existing routes:

```typescript
import emuIngestRoutes from './emulator-ingest-routes';
// In the route mounting section:
app.route('/api/orders', emuIngestRoutes);
```

- [ ] **Step 4: Rebuild + test ingest endpoint returns 401 without key**

```bash
docker compose up -d --build
curl -s -X POST http://localhost:3000/api/orders/ingest | jq .
```

Expected: `{"error": "Missing X-Emulator-Key"}`

- [ ] **Step 5: Commit**

```bash
git add src/web/emulator-ingest-routes.ts src/web/routes.ts
git commit -m "feat: add order ingest and heartbeat endpoints with JWT bypass"
```

---

### Task 7: Admin emulator routes

**Files:**
- Create: `src/web/emulator-admin-routes.ts`
- Modify: `src/web/routes.ts` (mount)

- [ ] **Step 1: Write admin routes**

```typescript
import { Hono } from 'hono';
import { adminMiddleware } from './auth-middleware';
import * as orchestrator from '../services/emulator-orchestrator';
import * as emuRepo from '../db/emulator-repository';
import * as docker from '../services/docker-client';

const app = new Hono();
app.use('/*', adminMiddleware);

// List all emulator instances
app.get('/', async (c) => {
  const instances = await emuRepo.getAllInstances();
  return c.json(instances);
});

// Create emulator for a cabinet
app.post('/', async (c) => {
  const userId = c.get('userId') as number;
  const { cabinetId } = await c.req.json<{ cabinetId: number }>();
  if (!cabinetId) return c.json({ error: 'cabinetId required' }, 400);

  try {
    const instance = await orchestrator.provisionEmulator(cabinetId, userId);
    return c.json(instance, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Delete emulator instance
app.delete('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const removeVolume = c.req.query('removeVolume') === 'true';

  try {
    await orchestrator.deleteEmulator(id, removeVolume);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Force restart
app.post('/:id/restart', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    await orchestrator.stopEmulator(id);
    await orchestrator.startEmulator(id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// View logs
app.get('/:id/logs', async (c) => {
  const id = parseInt(c.req.param('id'));
  const tail = parseInt(c.req.query('tail') || '100');
  const inst = await emuRepo.getInstanceById(id);
  if (!inst) return c.json({ error: 'Not found' }, 404);

  const logs: Record<string, string> = {};
  if (inst.emu_container_id) {
    try { logs.redroid = await docker.getContainerLogs(inst.emu_container_id, tail); } catch {}
  }
  if (inst.scrcpy_container_id) {
    try { logs.scrcpy = await docker.getContainerLogs(inst.scrcpy_container_id, tail); } catch {}
  }
  if (inst.monitor_container_id) {
    try { logs.monitor = await docker.getContainerLogs(inst.monitor_container_id, tail); } catch {}
  }
  return c.json(logs);
});

export default app;
```

- [ ] **Step 2: Mount in routes.ts with admin middleware**

```typescript
import emuAdminRoutes from './emulator-admin-routes';
// Mount under admin section (requires adminMiddleware):
app.route('/api/admin/emulators', emuAdminRoutes);
```

Ensure `adminMiddleware` is applied before this route group (check existing admin route pattern in `routes.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/web/emulator-admin-routes.ts src/web/routes.ts
git commit -m "feat: add admin emulator CRUD routes"
```

---

### Task 8: User emulator routes

**Files:**
- Create: `src/web/emulator-routes.ts`
- Modify: `src/web/routes.ts` (mount)

- [ ] **Step 1: Write user routes**

```typescript
import { Hono } from 'hono';
import * as orchestrator from '../services/emulator-orchestrator';
import * as emuRepo from '../db/emulator-repository';
import * as docker from '../services/docker-client';

const app = new Hono();

// Get my emulator (based on selected cabinet)
app.get('/mine', async (c) => {
  const cabinetId = c.get('cabinetId') as number;
  if (!cabinetId) return c.json({ error: 'No cabinet selected' }, 400);

  const inst = await emuRepo.getInstanceByCabinetId(cabinetId);
  if (!inst) return c.json(null);

  // Enrich with live data
  let uptime: string | null = null;
  if (inst.emu_container_id && inst.status === 'running') {
    try {
      const info = await docker.inspectContainer(inst.emu_container_id);
      uptime = info.State.StartedAt;
    } catch {}
  }

  const ordersToday = await emuRepo.getEmuOrdersToday(inst.cabinet_id);
  const lastOrder = await emuRepo.getLastEmuOrder(inst.cabinet_id);

  return c.json({
    ...inst,
    ingest_api_key: undefined, // don't leak to frontend
    uptime,
    ordersToday,
    lastOrder,
  });
});

// Start emulator
app.post('/start', async (c) => {
  const cabinetId = c.get('cabinetId') as number;
  const inst = await emuRepo.getInstanceByCabinetId(cabinetId);
  if (!inst) return c.json({ error: 'No emulator assigned' }, 404);

  try {
    await orchestrator.startEmulator(inst.id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Stop emulator
app.post('/stop', async (c) => {
  const cabinetId = c.get('cabinetId') as number;
  const inst = await emuRepo.getInstanceByCabinetId(cabinetId);
  if (!inst) return c.json({ error: 'No emulator assigned' }, 404);

  try {
    await orchestrator.stopEmulator(inst.id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Start monitor
app.post('/start-monitor', async (c) => {
  const cabinetId = c.get('cabinetId') as number;
  const inst = await emuRepo.getInstanceByCabinetId(cabinetId);
  if (!inst) return c.json({ error: 'No emulator assigned' }, 404);

  try {
    await orchestrator.startMonitor(inst.id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Stop monitor
app.post('/stop-monitor', async (c) => {
  const cabinetId = c.get('cabinetId') as number;
  const inst = await emuRepo.getInstanceByCabinetId(cabinetId);
  if (!inst) return c.json({ error: 'No emulator assigned' }, 404);

  try {
    await orchestrator.stopMonitor(inst.id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

export default app;
```

- [ ] **Step 2: Mount in routes.ts**

```typescript
import emuRoutes from './emulator-routes';
app.route('/api/emulators', emuRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add src/web/emulator-routes.ts src/web/routes.ts
git commit -m "feat: add user emulator control routes"
```

---

### Task 9: Auth check endpoint for nginx

**Files:**
- Modify: `src/web/auth-routes.ts` (add check-emu handler, around line 50)

- [ ] **Step 1: Add check-emu endpoint**

Follow the existing `check-admin` pattern in `auth-routes.ts`:

```typescript
// Add after the check-admin endpoint
app.get('/api/auth/check-emu',
  authMiddleware,
  async (c) => {
    const userId = c.get('userId') as number;
    const originalUri = c.req.header('X-Original-URI') || '';

    // Extract instance ID from /emu/{id}/...
    const match = originalUri.match(/^\/emu\/(\d+)\//);
    if (!match) return c.text('Forbidden', 403);

    const instanceId = parseInt(match[1]);
    const instance = await emuRepo.getInstanceById(instanceId);
    if (!instance) return c.text('Not found', 404);

    // Check user has access to the instance's cabinet
    const hasAccess = await cabinetsRepo.userHasAccessToCabinet(userId, instance.cabinet_id);
    if (!hasAccess) return c.text('Forbidden', 403);

    return c.text('OK', 200);
  }
);
```

Add imports at the top:
```typescript
import * as emuRepo from '../db/emulator-repository';
import * as cabinetsRepo from '../db/cabinets-repository';
```

- [ ] **Step 2: Commit**

```bash
git add src/web/auth-routes.ts
git commit -m "feat: add nginx auth check endpoint for emulator access"
```

---

### Task 10: Register health check scheduler + add SPA route

**Files:**
- Modify: `src/index.ts` (add scheduler task + SPA route)

- [ ] **Step 1: Add health check scheduler task**

In `src/index.ts`, after the existing scheduler task registrations (around line 453), add:

```typescript
import { healthCheck } from './services/emulator-orchestrator';

scheduler.registerTask('emulator-health-check', 60_000, async () => {
  try {
    await healthCheck();
  } catch (err) {
    console.error('[Scheduler] emulator-health-check failed:', err);
  }
});
```

- [ ] **Step 2: Add `/emulator` SPA route**

In the `routes` section of `Bun.serve()` (around line 487-497), add `/emulator` alongside the existing SPA routes:

```typescript
"/emulator": index,
```

- [ ] **Step 3: Rebuild and test**

```bash
docker compose up -d --build
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register emulator health check scheduler and SPA route"
```

---

## Chunk 4: Monitor Docker Image

### Task 11: Python monitor sidecar image

**Files:**
- Create: `docker/wb-monitor/Dockerfile`
- Create: `docker/wb-monitor/run.py`
- Create: `docker/wb-monitor/parser.py`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM python:3.12-slim

RUN pip install --no-cache-dir uiautomator2 requests && \
    apt-get update && apt-get install -y --no-install-recommends android-tools-adb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY . /opt/wb-monitor/
WORKDIR /opt/wb-monitor

CMD ["python3", "run.py"]
```

- [ ] **Step 2: Create parser.py**

Extract the UI parsing logic from `WBPartners-Auto/wb_order_monitor.py` (lines 78-150):

```python
"""Parse WB Partners app order feed UI hierarchy."""
import re

REQUIRED_FIELDS = {'article', 'status', 'date_raw', 'price'}


def parse_price_cents(price_str):
    """Convert '2 784 ₽' to 278400 (kopecks)."""
    digits = re.sub(r'[^\d]', '', price_str)
    return int(digits) * 100 if digits else 0


def parse_orders_from_hierarchy(xml_text):
    """Parse order cards from uiautomator2 XML dump.

    Returns list of order dicts.
    """
    import xml.etree.ElementTree as ET
    root = ET.fromstring(xml_text)

    orders = []
    # Find scrollable container from wb.partners package
    scroll_nodes = root.findall('.//*[@scrollable="true"]')

    for scroll in scroll_nodes:
        # Each direct child group is an order card
        for card in scroll:
            texts = [n.attrib.get('text', '') for n in card.iter() if n.attrib.get('text')]
            texts = [t for t in texts if t.strip()]
            if len(texts) < 4:
                continue

            order = _extract_order_fields(texts)
            if order and all(order.get(f) for f in REQUIRED_FIELDS):
                order['dedup_key'] = f"{order['article']}|{order.get('size', '')}|{order['status']}|{order['date_raw']}"
                order['price_cents'] = parse_price_cents(order.get('price', ''))
                orders.append(order)

    return orders


def _extract_order_fields(texts):
    """Map text nodes to order fields by position/pattern."""
    order = {}

    for t in texts:
        t = t.strip()
        if not t:
            continue
        # Status patterns
        if t in ('Заказ', 'Отказ', 'Выкуп', 'Возврат'):
            order['status'] = t
        # Price pattern: contains ₽
        elif '₽' in t:
            order['price'] = t
        # Date pattern: contains comma + time
        elif re.match(r'\d{1,2}\s+\w{3},\s+\d{2}:\d{2}', t):
            order['date_raw'] = t
        # Article: numeric, 5-15 digits
        elif re.match(r'^\d{5,15}$', t):
            order['article'] = t
        # Size
        elif re.match(r'^[A-Z0-9]{1,5}$|^\d{2,3}$', t) and 'size' not in order:
            order['size'] = t

    # Remaining fields from position
    remaining = [t for t in texts if t.strip() not in order.values()]
    if remaining and 'product' not in order:
        order['product'] = remaining[0]
    if len(remaining) > 1 and 'warehouse' not in order:
        order['warehouse'] = remaining[-2] if len(remaining) > 2 else None
        order['arrival_city'] = remaining[-1]

    return order
```

- [ ] **Step 3: Create run.py**

```python
"""WB Partners order monitor — sidecar container version.

Connects to Redroid via ADB, scrapes order feed, POSTs to ingest API.
"""
import os
import sys
import time
import signal
import threading
import json
import requests
import uiautomator2 as u2
from parser import parse_orders_from_hierarchy

# Config from env
ADB_DEVICE = os.environ['ADB_DEVICE']
INGEST_URL = os.environ['INGEST_URL']
HEARTBEAT_URL = os.environ['HEARTBEAT_URL']
EMULATOR_KEY = os.environ['EMULATOR_KEY']
CABINET_ID = os.environ.get('CABINET_ID', '')

REFRESH_INTERVAL = 180  # seconds between scrapes
MAX_SCROLLS = 10
PID_FILE = '/var/run/wb-monitor.pid'

running = True


def signal_handler(sig, frame):
    global running
    running = False


signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)


def heartbeat_loop():
    """Send heartbeat every 30s in a background thread."""
    while running:
        try:
            requests.post(
                HEARTBEAT_URL,
                headers={'X-Emulator-Key': EMULATOR_KEY},
                timeout=10,
            )
        except Exception as e:
            print(f'[Heartbeat] Error: {e}', file=sys.stderr)
        time.sleep(30)


def send_orders(orders):
    """POST order batch to ingest endpoint."""
    if not orders:
        return
    try:
        resp = requests.post(
            INGEST_URL,
            json={'orders': orders},
            headers={'X-Emulator-Key': EMULATOR_KEY},
            timeout=30,
        )
        data = resp.json()
        print(f'[Ingest] Sent {len(orders)} orders: {data}')
    except Exception as e:
        print(f'[Ingest] Error: {e}', file=sys.stderr)


def connect_device():
    """Connect to Redroid via ADB."""
    print(f'[Monitor] Connecting to {ADB_DEVICE}...')
    os.system(f'adb connect {ADB_DEVICE}')
    time.sleep(3)
    d = u2.connect(ADB_DEVICE)
    print(f'[Monitor] Connected: {d.info}')
    return d


def pull_to_refresh(d):
    """Swipe down to refresh the order feed."""
    w, h = d.window_size()
    d.swipe(w // 2, h // 4, w // 2, h * 3 // 4, duration=0.5)
    time.sleep(2)


def scrape_orders(d):
    """Dump UI hierarchy and parse orders."""
    xml = d.dump_hierarchy()
    return parse_orders_from_hierarchy(xml)


def main():
    # Write PID file
    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))

    # Start heartbeat thread
    hb_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    hb_thread.start()

    # Connect to device
    d = connect_device()

    print(f'[Monitor] Starting order monitor for cabinet {CABINET_ID}')

    while running:
        try:
            pull_to_refresh(d)
            orders = scrape_orders(d)
            if orders:
                send_orders(orders)
            else:
                print('[Monitor] No orders found in current view')

            # Scroll down to find more orders
            for scroll_i in range(MAX_SCROLLS):
                if not running:
                    break
                w, h = d.window_size()
                d.swipe(w // 2, h * 3 // 4, w // 2, h // 4, duration=0.3)
                time.sleep(1)
                more_orders = scrape_orders(d)
                if more_orders:
                    send_orders(more_orders)
                else:
                    break

        except Exception as e:
            print(f'[Monitor] Error: {e}', file=sys.stderr)
            time.sleep(10)
            try:
                d = connect_device()
            except:
                pass

        # Wait before next refresh cycle
        for _ in range(REFRESH_INTERVAL):
            if not running:
                break
            time.sleep(1)

    print('[Monitor] Shutting down')
    try:
        os.remove(PID_FILE)
    except:
        pass


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Build the monitor image**

```bash
cd /data/ecomchick-second && docker build -t wb-emu-monitor:1.0 -f docker/wb-monitor/Dockerfile docker/wb-monitor/
```

Expected: Image builds successfully.

- [ ] **Step 5: Verify image**

```bash
docker run --rm wb-emu-monitor:1.0 python3 -c "import uiautomator2; import requests; print('OK')"
```

Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add docker/wb-monitor/
git commit -m "feat: add Python monitor sidecar Docker image"
```

---

## Chunk 5: Nginx Configuration + Migration

### Task 12: Set up nginx include and auth location

**Files:**
- Modify: `/etc/nginx/sites-enabled/bidberry.animeenigma.ru`

- [ ] **Step 1: Create empty emulators config**

```bash
touch /etc/nginx/conf.d/wb-emulators.conf
```

- [ ] **Step 2: Add include and auth location to nginx server block**

In `/etc/nginx/sites-enabled/bidberry.animeenigma.ru`, inside the `server { }` block (before the `location /` block), add:

```nginx
    # Emulator auth check (internal)
    location = /_auth/emu {
        internal;
        proxy_pass http://127.0.0.1:3000/api/auth/check-emu;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Original-URI $request_uri;
    }

    # Dynamic emulator locations (auto-generated)
    include /etc/nginx/conf.d/wb-emulators.conf;
```

- [ ] **Step 3: Test and reload nginx**

```bash
nginx -t && nginx -s reload
```

Expected: `syntax is ok`, `test is successful`.

- [ ] **Step 4: Verify the include path works inside the Bun container**

The Bun container has `/etc/nginx-conf` mounted to `/etc/nginx/conf.d`. Verify:

```bash
docker exec wb-analytics-app ls /etc/nginx-conf/wb-emulators.conf
```

Expected: File listed (empty but exists).

---

### Task 13: End-to-end smoke test (CLI)

- [ ] **Step 1: Rebuild the app**

```bash
docker compose up -d --build
```

- [ ] **Step 2: Create an emulator instance via CLI**

```bash
# Pick a cabinet ID that exists (check DB first)
docker exec wb-analytics-mysql mysql -uwb_user -pwb_s3cur3_p@ss2024 wb_analytics -e "SELECT id, name FROM cabinets LIMIT 5;"

# Create emulator for cabinet 1 (adjust ID as needed)
docker exec wb-analytics-app bun -e "
  const { provisionEmulator } = require('./src/services/emulator-orchestrator');
  const inst = await provisionEmulator(1, 1);
  console.log('Created:', JSON.stringify(inst, null, 2));
"
```

Expected: Emulator instance created, 3 containers visible in `docker ps`.

- [ ] **Step 3: Verify containers exist**

```bash
docker ps --filter label=wb.managed=true --format "table {{.Names}}\t{{.Status}}"
```

Expected: `emu-cabinet-1`, `scrcpy-cabinet-1`, `monitor-cabinet-1` listed (last one not started).

- [ ] **Step 4: Start the emulator**

```bash
docker exec wb-analytics-app bun -e "
  const { startEmulator } = require('./src/services/emulator-orchestrator');
  await startEmulator(1);
  console.log('Started');
"
```

Expected: Redroid boots, ws-scrcpy connects. Check `docker ps` shows both running.

- [ ] **Step 5: Verify ws-scrcpy is accessible**

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9090
```

Expected: `200` (ws-scrcpy serving).

- [ ] **Step 6: Test ingest endpoint**

```bash
# Get the API key from DB
docker exec wb-analytics-mysql mysql -uwb_user -pwb_s3cur3_p@ss2024 wb_analytics -e "SELECT ingest_api_key FROM emulator_instances LIMIT 1;" -N

# POST a test order
curl -s -X POST http://localhost:3000/api/orders/ingest \
  -H "Content-Type: application/json" \
  -H "X-Emulator-Key: <key_from_above>" \
  -d '{"orders":[{"article":"123456","product":"Test","size":"XL","status":"Заказ","price":"1 000 ₽","price_cents":100000,"date_raw":"17 мар, 12:00"}]}'
```

Expected: `{"inserted":1,"duplicates":0}`

- [ ] **Step 7: Verify order in DB**

```bash
docker exec wb-analytics-mysql mysql -uwb_user -pwb_s3cur3_p@ss2024 wb_analytics -e "SELECT * FROM emu_orders;"
```

Expected: 1 row with the test order data.

---

## Chunk 6: Frontend

### Task 14: User Emulator Page

**Files:**
- Create: `public/app/components/emulator/EmuPage.tsx`
- Modify: `public/app/App.tsx` (add route)
- Modify: `public/app/components/layout/AppSidebar.tsx` (add nav link)

- [ ] **Step 1: Create EmuPage.tsx**

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../hooks/useApi';

interface EmulatorStatus {
  id: number;
  cabinet_id: number;
  status: 'created' | 'running' | 'stopped' | 'error';
  monitor_status: 'stopped' | 'running' | 'error';
  scrcpy_port: number;
  last_heartbeat: string | null;
  error_message: string | null;
  uptime: string | null;
  ordersToday: number;
  lastOrder: string | null;
}

export default function EmuPage() {
  const [emu, setEmu] = useState<EmulatorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api('/emulators/mine');
      setEmu(data);
    } catch { setEmu(null); }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t); }, [refresh]);

  const doAction = async (action: string) => {
    setActionLoading(action);
    try {
      await api(`/emulators/${action}`, { method: 'POST' });
      await refresh();
    } catch (err: any) {
      alert(err.message);
    }
    setActionLoading('');
  };

  if (loading) return <div className="p-6">Loading...</div>;

  if (!emu) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Emulator</h1>
        <p className="text-gray-500">No emulator assigned to your cabinet. Contact admin to provision one.</p>
      </div>
    );
  }

  const statusColor = {
    running: 'bg-green-100 text-green-800',
    stopped: 'bg-gray-100 text-gray-800',
    error: 'bg-red-100 text-red-800',
    created: 'bg-yellow-100 text-yellow-800',
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Emulator</h1>

      {/* Status Card */}
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <span className="text-sm text-gray-500">Emulator</span>
            <span className={`ml-2 px-2 py-1 rounded text-xs font-medium ${statusColor[emu.status]}`}>
              {emu.status}
            </span>
          </div>
          <div>
            <span className="text-sm text-gray-500">Monitor</span>
            <span className={`ml-2 px-2 py-1 rounded text-xs font-medium ${statusColor[emu.monitor_status]}`}>
              {emu.monitor_status}
            </span>
          </div>
          <div>
            <span className="text-sm text-gray-500">Orders today</span>
            <span className="ml-2 font-bold">{emu.ordersToday}</span>
          </div>
          <div>
            <span className="text-sm text-gray-500">Last order</span>
            <span className="ml-2 text-sm">{emu.lastOrder ? new Date(emu.lastOrder).toLocaleTimeString() : '—'}</span>
          </div>
        </div>

        {emu.error_message && (
          <div className="mt-2 p-2 bg-red-50 text-red-700 rounded text-sm">{emu.error_message}</div>
        )}

        {/* Controls */}
        <div className="mt-4 flex gap-2">
          {emu.status === 'stopped' || emu.status === 'created' ? (
            <button onClick={() => doAction('start')} disabled={!!actionLoading}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
              {actionLoading === 'start' ? 'Starting...' : 'Start Emulator'}
            </button>
          ) : emu.status === 'running' ? (
            <>
              <button onClick={() => doAction('stop')} disabled={!!actionLoading}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                {actionLoading === 'stop' ? 'Stopping...' : 'Stop Emulator'}
              </button>
              {emu.monitor_status === 'stopped' || emu.monitor_status === 'error' ? (
                <button onClick={() => doAction('start-monitor')} disabled={!!actionLoading}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                  {actionLoading === 'start-monitor' ? 'Starting...' : 'Start Monitor'}
                </button>
              ) : (
                <button onClick={() => doAction('stop-monitor')} disabled={!!actionLoading}
                  className="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50">
                  {actionLoading === 'stop-monitor' ? 'Stopping...' : 'Stop Monitor'}
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* ws-scrcpy iframe */}
      {emu.status === 'running' && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <iframe
            src={`/emu/${emu.id}/`}
            className="w-full border-0"
            style={{ height: '80vh' }}
            title="Android Emulator"
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

Import and add route alongside existing ones (around line 52-61):

```tsx
import EmuPage from './components/emulator/EmuPage';

// In routes:
<Route path="/emulator" element={<EmuPage />} />
```

- [ ] **Step 3: Add sidebar link in AppSidebar.tsx**

Add to the nav items array (around line 6-14):

```tsx
{ path: '/emulator', label: 'Emulator', icon: '📱' },
```

- [ ] **Step 4: Rebuild and verify page loads**

```bash
docker compose up -d --build
```

Navigate to `https://bidberry.animeenigma.ru/emulator` — should show the emulator page (with "no emulator assigned" if none provisioned for the user's cabinet, or the status card + iframe if one exists).

- [ ] **Step 5: Commit**

```bash
git add public/app/components/emulator/EmuPage.tsx public/app/App.tsx public/app/components/layout/AppSidebar.tsx
git commit -m "feat: add user emulator page with status and ws-scrcpy viewer"
```

---

### Task 15: Admin Emulators tab

**Files:**
- Create: `public/app/components/admin/EmulatorAdmin.tsx`
- Modify: `public/app/components/admin/AdminPage.tsx` (add tab)

- [ ] **Step 1: Create EmulatorAdmin.tsx**

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../hooks/useApi';

interface EmulatorInstance {
  id: number;
  cabinet_id: number;
  emu_container_name: string;
  status: string;
  monitor_status: string;
  adb_port: number;
  scrcpy_port: number;
  created_at: string;
  error_message: string | null;
}

interface Cabinet {
  id: number;
  name: string;
}

export default function EmulatorAdmin() {
  const [instances, setInstances] = useState<EmulatorInstance[]>([]);
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [selectedCabinet, setSelectedCabinet] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [inst, cabs] = await Promise.all([
      api('/admin/emulators'),
      api('/admin/accounts'),
    ]);
    setInstances(inst || []);
    setCabinets(cabs || []);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const assignedCabinetIds = new Set(instances.map(i => i.cabinet_id));
  const unassignedCabinets = cabinets.filter(c => !assignedCabinetIds.has(c.id));

  const createEmulator = async () => {
    if (!selectedCabinet) return;
    try {
      await api('/admin/emulators', {
        method: 'POST',
        body: JSON.stringify({ cabinetId: selectedCabinet }),
      });
      setSelectedCabinet(0);
      await refresh();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const deleteEmulator = async (id: number) => {
    if (!confirm('Delete this emulator? The Android data volume will be preserved.')) return;
    try {
      await api(`/admin/emulators/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const restartEmulator = async (id: number) => {
    try {
      await api(`/admin/emulators/${id}/restart`, { method: 'POST' });
      await refresh();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {/* Create */}
      <div className="mb-4 flex gap-2 items-center">
        <select value={selectedCabinet} onChange={e => setSelectedCabinet(Number(e.target.value))}
          className="border rounded px-3 py-2">
          <option value={0}>Select cabinet...</option>
          {unassignedCabinets.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button onClick={createEmulator} disabled={!selectedCabinet}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
          Create Emulator
        </button>
      </div>

      {/* Table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2">ID</th>
            <th>Cabinet</th>
            <th>Status</th>
            <th>Monitor</th>
            <th>ADB Port</th>
            <th>Scrcpy Port</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {instances.map(inst => (
            <tr key={inst.id} className="border-b">
              <td className="py-2">{inst.id}</td>
              <td>{cabinets.find(c => c.id === inst.cabinet_id)?.name ?? inst.cabinet_id}</td>
              <td><span className={`px-2 py-1 rounded text-xs ${inst.status === 'running' ? 'bg-green-100' : inst.status === 'error' ? 'bg-red-100' : 'bg-gray-100'}`}>{inst.status}</span></td>
              <td><span className={`px-2 py-1 rounded text-xs ${inst.monitor_status === 'running' ? 'bg-green-100' : inst.monitor_status === 'error' ? 'bg-red-100' : 'bg-gray-100'}`}>{inst.monitor_status}</span></td>
              <td>{inst.adb_port}</td>
              <td>{inst.scrcpy_port}</td>
              <td>{new Date(inst.created_at).toLocaleDateString()}</td>
              <td className="flex gap-1">
                <button onClick={() => restartEmulator(inst.id)} className="text-blue-600 hover:underline text-xs">Restart</button>
                <button onClick={() => deleteEmulator(inst.id)} className="text-red-600 hover:underline text-xs">Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Add "Emulators" tab in AdminPage.tsx**

Import `EmulatorAdmin` and add it as a tab in the admin page tab system. The exact integration depends on the current tab structure — check `AdminPage.tsx` for the existing pattern and add:

```tsx
import EmulatorAdmin from './EmulatorAdmin';

// In the tabs array:
{ id: 'emulators', label: 'Emulators', component: EmulatorAdmin }
```

- [ ] **Step 3: Rebuild and test**

```bash
docker compose up -d --build
```

Navigate to admin page, "Emulators" tab should appear.

- [ ] **Step 4: Commit**

```bash
git add public/app/components/admin/EmulatorAdmin.tsx public/app/components/admin/AdminPage.tsx
git commit -m "feat: add admin emulators management tab"
```

---

## Chunk 7: Migration

### Task 16: Stop old emulator setup

- [ ] **Step 1: Stop old Redroid + ws-scrcpy**

```bash
cd /data/ecomchick-second/WBPartners-Auto && docker compose down
```

- [ ] **Step 2: Remove old /emu-proxy/ nginx location**

In `/etc/nginx/sites-enabled/bidberry.animeenigma.ru`, remove the `location /emu-proxy/ { ... }` block. Keep the `/_auth/admin` block as it's used elsewhere.

- [ ] **Step 3: Test and reload nginx**

```bash
nginx -t && nginx -s reload
```

- [ ] **Step 4: Provision first emulator via new system and test**

Use the admin panel or CLI to create an emulator for the primary cabinet. Start it, verify ws-scrcpy loads at `/emu/{id}/`, install WB Partners APK via ADB, log in, start monitor.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete multi-tenant emulator orchestration migration"
```
