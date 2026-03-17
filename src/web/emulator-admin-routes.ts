import { Hono } from 'hono';
import { adminMiddleware } from './auth-middleware';
import * as orchestrator from '../services/emulator-orchestrator';
import * as emuRepo from '../db/emulator-repository';
import * as docker from '../services/docker-client';

const app = new Hono();

// All emulator admin routes require admin role
app.use('/*', adminMiddleware);

// List all emulator instances
app.get('/', async (c) => {
  try {
    const instances = await emuRepo.getAllInstances();
    return c.json(instances);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Create emulator for a cabinet
app.post('/', async (c) => {
  try {
    const userId = c.get('userId' as never) as number;
    const { cabinetId } = await c.req.json();
    if (!cabinetId) {
      return c.json({ error: 'cabinetId is required' }, 400);
    }

    // Check if cabinet already has an emulator
    const existing = await emuRepo.getInstanceByCabinetId(cabinetId);
    if (existing) {
      return c.json({ error: `Cabinet ${cabinetId} already has an emulator instance (id=${existing.id})` }, 409);
    }

    const instance = await orchestrator.provisionEmulator(cabinetId, userId);
    return c.json(instance, 201);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Delete emulator
app.delete('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const removeVolume = c.req.query('removeVolume') === 'true';
    await orchestrator.deleteEmulator(id, removeVolume);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Force restart
app.post('/:id/restart', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    await orchestrator.stopEmulator(id);
    await orchestrator.startEmulator(id);
    return c.json({ success: true });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// View logs for all 3 containers
app.get('/:id/logs', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const instance = await emuRepo.getInstanceById(id);
    if (!instance) {
      return c.json({ error: `Emulator instance ${id} not found` }, 404);
    }

    const tail = parseInt(c.req.query('tail') || '200');

    const [emuLogs, scrcpyLogs, monitorLogs] = await Promise.all([
      instance.emu_container_id
        ? docker.getContainerLogs(instance.emu_container_id, tail).catch((e: Error) => `Error: ${e.message}`)
        : Promise.resolve('(no container)'),
      instance.scrcpy_container_id
        ? docker.getContainerLogs(instance.scrcpy_container_id, tail).catch((e: Error) => `Error: ${e.message}`)
        : Promise.resolve('(no container)'),
      instance.monitor_container_id
        ? docker.getContainerLogs(instance.monitor_container_id, tail).catch((e: Error) => `Error: ${e.message}`)
        : Promise.resolve('(no container)'),
    ]);

    return c.json({
      redroid: emuLogs,
      scrcpy: scrcpyLogs,
      monitor: monitorLogs,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
