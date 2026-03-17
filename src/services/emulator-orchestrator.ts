/**
 * Emulator Orchestrator
 *
 * Manages the lifecycle of Redroid + ws-scrcpy + Python monitor container trios
 * for each cabinet. Handles provisioning, starting, stopping, deletion,
 * health checks, and nginx config regeneration.
 */

import * as docker from './docker-client';
import * as emuRepo from '../db/emulator-repository';
import type { EmulatorInstance } from '../db/emulator-repository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REDROID_IMAGE = 'redroid/redroid:14.0.0-latest';
const SCRCPY_IMAGE = 'scavin/ws-scrcpy:latest';
const MONITOR_IMAGE = 'wb-emu-monitor:1.0';
const BUN_APP_PORT = process.env.APP_PORT || '3000';

const SCRCPY_CONFIG_DIR = '/etc/wb-emulators';
const NGINX_CONF_DIR = '/etc/nginx-conf';
const NGINX_CONF_FILE = `${NGINX_CONF_DIR}/wb-emulators.conf`;
const NGINX_RELOAD_TRIGGER = `${NGINX_CONF_DIR}/.reload-trigger`;

// Nanosecond conversions for Docker healthcheck
const NS_PER_SEC = 1_000_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// provisionEmulator
// ---------------------------------------------------------------------------

export async function provisionEmulator(
  cabinetId: number,
  createdBy: number,
): Promise<EmulatorInstance> {
  const apiKey = generateApiKey();

  // 1. Allocate ports and create DB row atomically
  const instance = await emuRepo.allocatePortsAndCreate(cabinetId, createdBy, apiKey);

  try {
    // 2. Create Redroid container
    const emuContainerId = await docker.createContainer(instance.emu_container_name, {
      Image: REDROID_IMAGE,
      Cmd: [
        'androidboot.hardware=redroid',
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
        Memory: 1610612736, // 1.5 GB
        NanoCpus: 2_000_000_000, // 2 cores
        RestartPolicy: { Name: 'unless-stopped' },
      },
      Labels: {
        'wb.cabinet_id': String(cabinetId),
        'wb.managed': 'true',
        'wb.type': 'redroid',
      },
      Healthcheck: {
        Test: ['CMD-SHELL', 'getprop sys.boot_completed | grep -q 1'],
        Interval: 10 * NS_PER_SEC,
        Timeout: 5 * NS_PER_SEC,
        Retries: 30,
        StartPeriod: 60 * NS_PER_SEC,
      },
    });

    // 3. Write ws-scrcpy config
    const scrcpyConfigPath = `${SCRCPY_CONFIG_DIR}/ws-scrcpy-${cabinetId}.yaml`;
    const scrcpyConfigContent = [
      'runGoogTracker: true',
      'announceGoogTracker: true',
      'server:',
      '  - secure: false',
      `    port: ${instance.scrcpy_port}`,
      '',
    ].join('\n');
    await Bun.write(scrcpyConfigPath, scrcpyConfigContent);

    // 4. Create ws-scrcpy container
    const scrcpyContainerId = await docker.createContainer(instance.scrcpy_container_name, {
      Image: SCRCPY_IMAGE,
      Entrypoint: ['/bin/bash'],
      Cmd: ['-c', `adb connect 127.0.0.1:${instance.adb_port} && sleep 3 && npm start`],
      HostConfig: {
        NetworkMode: 'host',
        Binds: [`${scrcpyConfigPath}:/ws-scrcpy/config.yaml:ro`],
        RestartPolicy: { Name: 'unless-stopped' },
      },
      Env: [`WS_SCRCPY_CONFIG=/ws-scrcpy/config.yaml`],
      Labels: {
        'wb.cabinet_id': String(cabinetId),
        'wb.managed': 'true',
        'wb.type': 'scrcpy',
      },
    });

    // 5. Create monitor container (NOT started)
    const monitorContainerId = await docker.createContainer(instance.monitor_container_name, {
      Image: MONITOR_IMAGE,
      Env: [
        `ADB_DEVICE=127.0.0.1:${instance.adb_port}`,
        `INGEST_URL=http://127.0.0.1:${BUN_APP_PORT}/api/orders/ingest`,
        `HEARTBEAT_URL=http://127.0.0.1:${BUN_APP_PORT}/api/emulators/${instance.id}/heartbeat`,
        `EMULATOR_KEY=${apiKey}`,
        `CABINET_ID=${cabinetId}`,
      ],
      HostConfig: {
        NetworkMode: 'host',
        Memory: 268435456, // 256 MB
        NanoCpus: 500_000_000, // 0.5 cores
        RestartPolicy: { Name: 'no' },
      },
      Labels: {
        'wb.cabinet_id': String(cabinetId),
        'wb.managed': 'true',
        'wb.type': 'monitor',
      },
    });

    // 6. Update DB with container IDs
    await emuRepo.updateContainerIds(
      instance.id,
      emuContainerId,
      scrcpyContainerId,
      monitorContainerId,
    );

    // 7. Regenerate nginx config
    await regenerateNginxConfig();

    // Return the updated instance
    const updated = await emuRepo.getInstanceById(instance.id);
    return updated!;
  } catch (err) {
    // Cleanup on failure: remove any containers that were created, then delete DB row
    await cleanupFailedProvision(instance).catch(() => {});
    await emuRepo.deleteInstance(instance.id).catch(() => {});
    throw err;
  }
}

/**
 * Best-effort cleanup of containers created during a failed provision.
 */
async function cleanupFailedProvision(instance: EmulatorInstance): Promise<void> {
  const current = await emuRepo.getInstanceById(instance.id);
  if (!current) return;

  const ids = [
    current.emu_container_id,
    current.scrcpy_container_id,
    current.monitor_container_id,
  ];

  for (const id of ids) {
    if (id) {
      await docker.removeContainer(id, true).catch(() => {});
    }
  }

  // Also try removing by name in case container IDs weren't saved yet
  const names = [
    instance.emu_container_name,
    instance.scrcpy_container_name,
    instance.monitor_container_name,
  ];

  for (const name of names) {
    await docker.removeContainer(name, true).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// startEmulator
// ---------------------------------------------------------------------------

export async function startEmulator(instanceId: number): Promise<void> {
  const instance = await emuRepo.getInstanceById(instanceId);
  if (!instance) throw new Error(`Emulator instance ${instanceId} not found`);
  if (!instance.emu_container_id) throw new Error(`Emulator ${instanceId} has no redroid container`);
  if (!instance.scrcpy_container_id) throw new Error(`Emulator ${instanceId} has no scrcpy container`);

  // Start redroid
  await docker.startContainer(instance.emu_container_id);

  // Poll health for up to 90 seconds (18 attempts * 5s interval)
  let healthy = false;
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    try {
      const info = await docker.inspectContainer(instance.emu_container_id);
      if (info.State.Health?.Status === 'healthy') {
        healthy = true;
        break;
      }
      if (!info.State.Running) {
        throw new Error(
          `Redroid container exited unexpectedly (exit code ${info.State.ExitCode})`,
        );
      }
    } catch (err) {
      // Inspect can fail transiently during startup; keep trying
      if (i === 17) throw err;
    }
  }

  if (!healthy) {
    throw new Error('Redroid container did not become healthy within 90 seconds');
  }

  // Start ws-scrcpy
  await docker.startContainer(instance.scrcpy_container_id);

  // Update status
  await emuRepo.updateStatus(instanceId, 'running');
}

// ---------------------------------------------------------------------------
// stopEmulator
// ---------------------------------------------------------------------------

export async function stopEmulator(instanceId: number): Promise<void> {
  const instance = await emuRepo.getInstanceById(instanceId);
  if (!instance) throw new Error(`Emulator instance ${instanceId} not found`);

  // Stop monitor if running
  if (instance.monitor_container_id && instance.monitor_status === 'running') {
    await docker.stopContainer(instance.monitor_container_id, 10).catch(() => {});
    await emuRepo.updateMonitorStatus(instanceId, 'stopped');
  }

  // Stop ws-scrcpy
  if (instance.scrcpy_container_id) {
    await docker.stopContainer(instance.scrcpy_container_id, 10).catch(() => {});
  }

  // Stop redroid (30s timeout for graceful shutdown)
  if (instance.emu_container_id) {
    await docker.stopContainer(instance.emu_container_id, 30).catch(() => {});
  }

  await emuRepo.updateStatus(instanceId, 'stopped');
}

// ---------------------------------------------------------------------------
// startMonitor
// ---------------------------------------------------------------------------

export async function startMonitor(instanceId: number): Promise<void> {
  const instance = await emuRepo.getInstanceById(instanceId);
  if (!instance) throw new Error(`Emulator instance ${instanceId} not found`);
  if (!instance.monitor_container_id) {
    throw new Error(`Emulator ${instanceId} has no monitor container`);
  }

  await docker.startContainer(instance.monitor_container_id);
  await emuRepo.updateMonitorStatus(instanceId, 'running');
}

// ---------------------------------------------------------------------------
// stopMonitor
// ---------------------------------------------------------------------------

export async function stopMonitor(instanceId: number): Promise<void> {
  const instance = await emuRepo.getInstanceById(instanceId);
  if (!instance) throw new Error(`Emulator instance ${instanceId} not found`);
  if (!instance.monitor_container_id) {
    throw new Error(`Emulator ${instanceId} has no monitor container`);
  }

  await docker.stopContainer(instance.monitor_container_id, 10);
  await emuRepo.updateMonitorStatus(instanceId, 'stopped');
}

// ---------------------------------------------------------------------------
// deleteEmulator
// ---------------------------------------------------------------------------

export async function deleteEmulator(
  instanceId: number,
  removeVolume: boolean = false,
): Promise<void> {
  const instance = await emuRepo.getInstanceById(instanceId);
  if (!instance) throw new Error(`Emulator instance ${instanceId} not found`);

  // Stop all 3 containers (best-effort)
  for (const id of [
    instance.monitor_container_id,
    instance.scrcpy_container_id,
    instance.emu_container_id,
  ]) {
    if (id) {
      await docker.stopContainer(id, 10).catch(() => {});
    }
  }

  // Remove all 3 containers
  for (const id of [
    instance.monitor_container_id,
    instance.scrcpy_container_id,
    instance.emu_container_id,
  ]) {
    if (id) {
      await docker.removeContainer(id, true).catch(() => {});
    }
  }

  // Optionally remove data volume
  if (removeVolume) {
    await docker.removeVolume(`emu-data-${instance.cabinet_id}`).catch(() => {});
  }

  // Clean up ws-scrcpy config file
  const scrcpyConfigPath = `${SCRCPY_CONFIG_DIR}/ws-scrcpy-${instance.cabinet_id}.yaml`;
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(scrcpyConfigPath);
  } catch {
    // File may not exist — that's fine
  }

  // Delete DB row
  await emuRepo.deleteInstance(instanceId);

  // Regenerate nginx config
  await regenerateNginxConfig();
}

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

export async function healthCheck(): Promise<void> {
  const instances = await emuRepo.getAllInstances();
  const now = Date.now();

  for (const instance of instances) {
    try {
      // Check orphaned 'created' rows with no containers, older than 5 minutes
      if (
        instance.status === 'created' &&
        !instance.emu_container_id &&
        !instance.scrcpy_container_id &&
        !instance.monitor_container_id
      ) {
        const age = now - new Date(instance.created_at).getTime();
        if (age > 5 * 60 * 1000) {
          console.log(
            `[health] Removing orphaned instance ${instance.id} (cabinet ${instance.cabinet_id})`,
          );
          await emuRepo.deleteInstance(instance.id);
          continue;
        }
      }

      // Check running redroid containers
      if (instance.status === 'running' && instance.emu_container_id) {
        try {
          const info = await docker.inspectContainer(instance.emu_container_id);
          if (!info.State.Running) {
            const reason = info.State.OOMKilled
              ? 'OOMKilled'
              : `exited with code ${info.State.ExitCode}`;
            console.error(
              `[health] Redroid container for instance ${instance.id} is dead: ${reason}`,
            );
            await emuRepo.updateStatus(instance.id, 'error', `Redroid container died: ${reason}`);
          }
        } catch (err) {
          console.error(
            `[health] Failed to inspect redroid for instance ${instance.id}:`,
            err,
          );
          await emuRepo.updateStatus(
            instance.id,
            'error',
            `Failed to inspect redroid container: ${(err as Error).message}`,
          );
        }
      }

      // Check running monitors — heartbeat must be within 120 seconds
      if (instance.monitor_status === 'running') {
        if (instance.last_heartbeat) {
          const heartbeatAge = now - new Date(instance.last_heartbeat).getTime();
          if (heartbeatAge > 120_000) {
            console.error(
              `[health] Monitor for instance ${instance.id} missed heartbeat ` +
                `(last: ${Math.round(heartbeatAge / 1000)}s ago)`,
            );
            await emuRepo.updateMonitorStatus(instance.id, 'error');
            await emuRepo.updateStatus(
              instance.id,
              'error',
              `Monitor heartbeat timeout (${Math.round(heartbeatAge / 1000)}s)`,
            );
          }
        } else {
          // No heartbeat ever recorded — could be freshly started, give it time
          const monitorAge = now - new Date(instance.updated_at).getTime();
          if (monitorAge > 120_000) {
            console.error(
              `[health] Monitor for instance ${instance.id} never sent a heartbeat`,
            );
            await emuRepo.updateMonitorStatus(instance.id, 'error');
            await emuRepo.updateStatus(
              instance.id,
              'error',
              'Monitor never sent initial heartbeat',
            );
          }
        }
      }
    } catch (err) {
      console.error(`[health] Error checking instance ${instance.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// regenerateNginxConfig
// ---------------------------------------------------------------------------

export async function regenerateNginxConfig(): Promise<void> {
  const instances = await emuRepo.getAllInstances();

  const locationBlocks = instances.map((inst) => {
    return `
    # Cabinet ${inst.cabinet_id} — instance ${inst.id}
    location /emu/${inst.id}/ {
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
    }`;
  });

  const config = `# Auto-generated by EmulatorOrchestrator — do not edit manually
# Generated at ${new Date().toISOString()}
${locationBlocks.join('\n')}
`;

  // Atomic write: write to tmp file, then rename
  const tmpFile = `${NGINX_CONF_FILE}.tmp`;
  await Bun.write(tmpFile, config);

  const { rename } = await import('node:fs/promises');
  await rename(tmpFile, NGINX_CONF_FILE);

  // Write reload trigger for the host-side watcher
  await Bun.write(NGINX_RELOAD_TRIGGER, String(Date.now()));
}
