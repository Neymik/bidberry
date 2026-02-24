import index from '../public/index.html';
import { Hono } from 'hono';
import routes from './web/routes';
import * as scheduler from './services/scheduler';
import * as keywordTracker from './services/keyword-tracker';
import * as financialService from './services/financial-service';
import * as smartBidder from './services/smart-bidder';
import dayjs from 'dayjs';

const api = new Hono();

// Mount all API routes
api.route('/', routes);

const port = parseInt(process.env.APP_PORT || '3000');

// Register scheduler tasks
scheduler.registerTask('keyword-positions', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Checking keyword positions...');
  const result = await keywordTracker.checkAllPositions();
  console.log(`[Scheduler] Keywords checked: ${result.checked}, errors: ${result.errors}`);
});

scheduler.registerTask('sales-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing sales report...');
  const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const dateTo = dayjs().format('YYYY-MM-DD');
  const count = await financialService.syncSalesReport(dateFrom, dateTo);
  console.log(`[Scheduler] Sales synced: ${count}`);
});

scheduler.registerTask('smart-bidder', 30 * 60 * 1000, async () => {
  console.log('[Scheduler] Running smart bidder...');
  const result = await smartBidder.runAllRules();
  console.log(`[Scheduler] Bidder: ${result.campaigns} campaigns, ${result.adjusted} adjusted, ${result.errors} errors`);
});

// Start scheduler if not in test mode
if (process.env.NODE_ENV !== 'test') {
  scheduler.start();
}

console.log(`
╔═══════════════════════════════════════════════════════╗
║           WB Analytics Dashboard v2.0                 ║
║                                                       ║
║   Server running at http://localhost:${port}             ║
║                                                       ║
║   Pages:                                              ║
║   • /                  - Dashboard                    ║
║   • /campaigns         - Campaigns & Bidder           ║
║   • /products          - Products                     ║
║   • /keywords          - SEO / Keywords               ║
║   • /financial         - P&L / Unit Economics         ║
║   • /import-export     - Import / Export              ║
║                                                       ║
║   New API endpoints:                                  ║
║   • /api/products/:id/keywords  - Keyword tracking    ║
║   • /api/financial/pnl          - P&L analytics       ║
║   • /api/financial/unit-economics/:id                 ║
║   • /api/campaigns/:id/bid-rules - Smart bidder       ║
║   • /api/smart-bidder/run       - Run all bid rules   ║
║   • /api/sync/sales-report      - Sync WB sales       ║
║   • /api/sync/keyword-positions - Check positions     ║
╚═══════════════════════════════════════════════════════╝
`);

Bun.serve({
  port,
  routes: {
    '/': index,
    '/campaigns': index,
    '/products': index,
    '/keywords': index,
    '/financial': index,
    '/import-export': index,
  },
  fetch: api.fetch,
  development: process.env.NODE_ENV !== 'production',
});
