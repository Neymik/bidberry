import { Hono } from 'hono';
import * as orchestrator from '../services/emulator-orchestrator';
import * as emuRepo from '../db/emulator-repository';
import * as docker from '../services/docker-client';

const app = new Hono();

// Get my emulator (based on selected cabinet from X-Cabinet-Id header)
app.get('/mine', async (c) => {
  const cabinetId = c.get('cabinetId' as never) as number;
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
  const cabinetId = c.get('cabinetId' as never) as number;
  if (!cabinetId) return c.json({ error: 'No cabinet selected' }, 400);

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
  const cabinetId = c.get('cabinetId' as never) as number;
  if (!cabinetId) return c.json({ error: 'No cabinet selected' }, 400);

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
  const cabinetId = c.get('cabinetId' as never) as number;
  if (!cabinetId) return c.json({ error: 'No cabinet selected' }, 400);

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
  const cabinetId = c.get('cabinetId' as never) as number;
  if (!cabinetId) return c.json({ error: 'No cabinet selected' }, 400);

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
