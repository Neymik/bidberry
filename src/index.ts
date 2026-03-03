import index from '../public/index.html';
import { Hono } from 'hono';
import routes from './web/routes';
import * as scheduler from './services/scheduler';
import * as keywordTracker from './services/keyword-tracker';
import * as financialService from './services/financial-service';
import * as smartBidder from './services/smart-bidder';
import * as repo from './db/repository';
import * as trafficRepo from './db/traffic-repository';
import * as promosRepo from './db/promotions-repository';
import * as ordersService from './services/orders-service';
import * as stockService from './services/stock-service';
import { getWBClient } from './api/wb-client';
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

scheduler.registerTask('campaigns-sync', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing campaigns...');
  const importId = await repo.createImportRecord('campaigns-sync');
  try {
    const wbClient = getWBClient();
    const campaigns = await wbClient.getCampaigns();
    const count = await repo.upsertCampaigns(campaigns);
    await repo.updateImportRecord(importId, 'completed', count);
    console.log(`[Scheduler] Campaigns synced: ${count}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Campaigns sync error: ${error.message}`);
  }
});

scheduler.registerTask('campaign-stats-sync', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing campaign stats...');
  const importId = await repo.createImportRecord('campaign-stats-sync');
  try {
    const wbClient = getWBClient();
    const campaigns = await repo.getCampaigns();
    const campaignIds = campaigns.map(c => c.campaign_id);
    if (campaignIds.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      return;
    }
    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    const stats = await wbClient.getCampaignStats(campaignIds, dateFrom, dateTo);
    const count = await repo.upsertCampaignStatsBatch(stats);
    await repo.updateImportRecord(importId, 'completed', count);
    console.log(`[Scheduler] Campaign stats synced: ${count}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Campaign stats sync error: ${error.message}`);
  }
});

scheduler.registerTask('products-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing products...');
  const importId = await repo.createImportRecord('products-sync');
  try {
    const wbClient = getWBClient();
    let totalSynced = 0;
    let errors = 0;
    let cursor: string | undefined;
    while (true) {
      try {
        const result = await wbClient.getProducts(100, cursor);
        const cards = result.cards || [];
        if (cards.length === 0) break;
        for (const card of cards) {
          await repo.upsertProduct({
            nmId: card.nmID,
            vendorCode: card.vendorCode,
            brand: card.brand,
            subject: card.subjectName || card.subject,
            name: card.title || card.name,
          });
          totalSynced++;
        }
        if (!result.cursor || cards.length < 100) break;
        cursor = JSON.stringify(result.cursor);
        await Bun.sleep(500);
      } catch (err: any) {
        errors++;
        console.error(`[Scheduler] Products page error: ${err.message}`);
        break;
      }
    }
    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced);
    console.log(`[Scheduler] Products synced: ${totalSynced}, errors: ${errors}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Products sync error: ${error.message}`);
  }
});

scheduler.registerTask('product-analytics-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing product analytics...');
  const importId = await repo.createImportRecord('product-analytics-sync');
  try {
    const wbClient = getWBClient();
    const products = await repo.getProducts();
    if (products.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      return;
    }
    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    let totalSynced = 0;
    let errors = 0;
    const batchSize = 20;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const nmIds = batch.map(p => p.nm_id);
      try {
        const analytics = await wbClient.getProductAnalytics(nmIds, dateFrom, dateTo);
        for (const item of analytics) {
          if (item.statistics?.selectedPeriod) {
            await repo.upsertProductAnalytics(item, dateFrom);
            totalSynced++;
          }
        }
      } catch (err: any) {
        errors++;
        console.error(`[Scheduler] Product analytics batch ${Math.floor(i / batchSize) + 1} error: ${err.message}`);
      }
      if (i + batchSize < products.length) await Bun.sleep(500);
    }
    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced);
    console.log(`[Scheduler] Product analytics synced: ${totalSynced}, errors: ${errors}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Product analytics sync error: ${error.message}`);
  }
});

scheduler.registerTask('traffic-sources-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing traffic sources...');
  const importId = await repo.createImportRecord('traffic-sources-sync');
  try {
    const wbClient = getWBClient();
    const products = await repo.getProducts();
    if (products.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      return;
    }
    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    let totalSynced = 0;
    let errors = 0;
    const batchSize = 20;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const nmIds = batch.map(p => p.nm_id);
      try {
        const response = await wbClient.getProductAnalyticsDetailed(nmIds, dateFrom, dateTo);
        const items = response?.data?.products || [];
        for (const item of items) {
          const nmId = item.product?.nmId;
          const stats = item.statistic?.selected;
          if (!nmId || !stats) continue;
          await trafficRepo.upsertTrafficSource({
            nm_id: nmId,
            date: dateFrom,
            source_name: 'total',
            open_card_count: stats.openCount ?? 0,
            add_to_cart_count: stats.cartCount ?? 0,
            orders_count: stats.orderCount ?? 0,
            orders_sum: stats.orderSum ?? 0,
            buyouts_count: stats.buyoutCount ?? 0,
            buyouts_sum: stats.buyoutSum ?? 0,
            cancel_count: stats.cancelCount ?? 0,
            cancel_sum: stats.cancelSum ?? 0,
          });
          totalSynced++;
        }
      } catch (err: any) {
        errors++;
        console.error(`[Scheduler] Traffic sources batch ${Math.floor(i / batchSize) + 1} error: ${err.message}`);
      }
      if (i + batchSize < products.length) await Bun.sleep(500);
    }
    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced);
    console.log(`[Scheduler] Traffic sources synced: ${totalSynced}, errors: ${errors}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Traffic sources sync error: ${error.message}`);
  }
});

scheduler.registerTask('prices-sync', 24 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing prices...');
  const importId = await repo.createImportRecord('prices-sync');
  try {
    const wbClient = getWBClient();
    let totalSynced = 0;
    let offset = 0;
    const limit = 1000;
    while (true) {
      const response = await wbClient.getPrices(limit, offset);
      const goods = response?.data?.listGoods || [];
      if (goods.length === 0) break;
      for (const item of goods) {
        const basePrice = item.sizes?.[0]?.price || item.price || 0;
        const discountedPrice = item.sizes?.[0]?.discountedPrice || basePrice;
        const discount = item.discount || (basePrice > 0 ? Math.round((1 - discountedPrice / basePrice) * 100) : 0);
        await repo.upsertProduct({
          nmId: item.nmID,
          price: basePrice,
          discount: discount,
          finalPrice: discountedPrice,
        });
        totalSynced++;
      }
      if (goods.length < limit) break;
      offset += limit;
      await Bun.sleep(500);
    }
    await repo.updateImportRecord(importId, 'completed', totalSynced);
    console.log(`[Scheduler] Prices synced: ${totalSynced}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Prices sync error: ${error.message}`);
  }
});

scheduler.registerTask('promotions-sync', 24 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing promotions...');
  const importId = await repo.createImportRecord('promotions-sync');
  try {
    const wbClient = getWBClient();
    const promotions = await wbClient.getPromotions();
    let totalSynced = 0;
    let errors = 0;
    const eligiblePromos = promotions.filter((p: any) => p.type !== 'auto');
    for (const promo of eligiblePromos) {
      try {
        const nomenclatures = await wbClient.getPromotionNomenclatures(promo.id);
        for (const nm of nomenclatures) {
          const nmId = nm.nmID || nm.nmId;
          if (!nmId) continue;
          await promosRepo.upsertPromoParticipation({
            nm_id: nmId,
            promo_id: promo.id,
            promo_name: promo.name || '',
            promo_type: promo.type || '',
            start_date: promo.startDateTime || '',
            end_date: promo.endDateTime || '',
            is_participating: true,
          });
          totalSynced++;
        }
      } catch (err: any) {
        if (!err.message?.includes('422')) {
          errors++;
          console.error(`[Scheduler] Promo ${promo.id} error: ${err.message}`);
        }
      }
      await Bun.sleep(600);
    }
    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced);
    console.log(`[Scheduler] Promotions synced: ${totalSynced}, errors: ${errors}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Promotions sync error: ${error.message}`);
  }
});

scheduler.registerTask('campaign-products-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing campaign products...');
  const importId = await repo.createImportRecord('campaign-products-sync');
  try {
    const wbClient = getWBClient();
    const campaigns = await repo.getCampaigns();
    let totalSynced = 0;
    let errors = 0;
    const batchSize = 50;
    for (let i = 0; i < campaigns.length; i += batchSize) {
      const batch = campaigns.slice(i, i + batchSize);
      const campaignIds = batch.map(c => c.campaign_id);
      try {
        const adverts = await wbClient.getCampaignsInfo(campaignIds);
        for (const advert of adverts) {
          const campId = advert.id || advert.advertId;
          if (!campId) continue;
          const nmSettings = advert.nm_settings || advert.unitedParams?.flatMap((p: any) => p.nms || []) || [];
          for (const nm of nmSettings) {
            const nmId = nm.nm_id || nm.nmId || nm.nmID;
            if (nmId) {
              await repo.upsertCampaignProduct(campId, nmId);
              totalSynced++;
            }
          }
        }
      } catch (err: any) {
        errors++;
        console.error(`[Scheduler] Campaign products batch error: ${err.message}`);
      }
      if (i + batchSize < campaigns.length) await Bun.sleep(300);
    }
    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced);
    console.log(`[Scheduler] Campaign products synced: ${totalSynced}, errors: ${errors}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Campaign products sync error: ${error.message}`);
  }
});

scheduler.registerTask('orders-sync', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing orders...');
  const importId = await repo.createImportRecord('orders-sync');
  try {
    const dateFrom = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const count = await ordersService.syncOrders(dateFrom);
    await repo.updateImportRecord(importId, 'completed', count);
    console.log(`[Scheduler] Orders synced: ${count}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Orders sync error: ${error.message}`);
  }
});

scheduler.registerTask('stocks-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing stocks...');
  const importId = await repo.createImportRecord('stocks-sync');
  try {
    const count = await stockService.syncStocks();
    await repo.updateImportRecord(importId, 'completed', count);
    console.log(`[Scheduler] Stocks synced: ${count}`);
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    console.error(`[Scheduler] Stocks sync error: ${error.message}`);
  }
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
