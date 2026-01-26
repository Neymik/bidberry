import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import routes from './web/routes';

const app = new Hono();

// Mount API routes
app.route('/', routes);

// Serve static files
app.use('/*', serveStatic({ root: './public' }));

// Fallback to index.html for SPA
app.get('/', async (c) => {
  const file = Bun.file('./public/index.html');
  return new Response(file, {
    headers: { 'Content-Type': 'text/html' },
  });
});

const port = parseInt(process.env.APP_PORT || '3000');

console.log(`
╔═══════════════════════════════════════════════════════╗
║           WB Analytics Dashboard                      ║
║                                                       ║
║   Server running at http://localhost:${port}             ║
║                                                       ║
║   API endpoints:                                      ║
║   • GET  /api/health          - Health check          ║
║   • GET  /api/dashboard       - Dashboard data        ║
║   • GET  /api/campaigns       - List campaigns        ║
║   • GET  /api/products        - List products         ║
║   • POST /api/sync/campaigns  - Sync from WB          ║
║   • GET  /api/export/*        - Export to Excel       ║
║   • POST /api/import/*        - Import from Excel     ║
╚═══════════════════════════════════════════════════════╝
`);

export default {
  port,
  fetch: app.fetch,
};
