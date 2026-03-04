import { Hono } from 'hono';
import * as importer from '../excel/importer';
import * as repo from '../db/repository';
import { getCabinetId } from './cabinet-context';

const app = new Hono();

app.post('/api/import/campaigns', async (c) => {
  const cabinetId = getCabinetId(c);
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ error: 'No file provided' }, 400);
    const buffer = await file.arrayBuffer();
    const tempPath = `/tmp/${Date.now()}_${file.name}`;
    await Bun.write(tempPath, buffer);
    const result = await importer.importCampaignsFromExcel(cabinetId, tempPath);
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/import/products', async (c) => {
  const cabinetId = getCabinetId(c);
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ error: 'No file provided' }, 400);
    const buffer = await file.arrayBuffer();
    const tempPath = `/tmp/${Date.now()}_${file.name}`;
    await Bun.write(tempPath, buffer);
    const result = await importer.importProductsFromExcel(cabinetId, tempPath);
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/import/costs', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ error: 'No file provided' }, 400);
    // For now, return a placeholder - full implementation would parse Excel with cost columns
    return c.json({ success: true, message: 'Cost import not yet implemented' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/templates/campaigns', (c) => {
  const buffer = importer.generateCampaignTemplate();
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="campaigns_template.xlsx"',
    },
  });
});

app.get('/api/templates/products', (c) => {
  const buffer = importer.generateProductTemplate();
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="products_template.xlsx"',
    },
  });
});

app.get('/api/templates/bids', (c) => {
  const buffer = importer.generateBidsTemplate();
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="bids_template.xlsx"',
    },
  });
});

app.get('/api/import-history', async (c) => {
  const cabinetId = getCabinetId(c);
  try {
    const history = await repo.getImportHistory(cabinetId);
    return c.json(history);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
