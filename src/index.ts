import index from '../public/index.html';
import { Hono } from 'hono';
import routes from './web/routes';
import * as scheduler from './services/scheduler';
import * as keywordTracker from './services/keyword-tracker';
import * as financialService from './services/financial-service';
import * as smartBidder from './services/smart-bidder';
import * as searchService from './services/search-analytics-service';
import * as repo from './db/repository';
import * as trafficRepo from './db/traffic-repository';
import * as promosRepo from './db/promotions-repository';
import * as ordersService from './services/orders-service';
import * as stockService from './services/stock-service';
import { syncFinancial } from './services/financial-sync';
import * as cabinetsRepo from './db/cabinets-repository';
import { getWBClientForCabinet } from './api/wb-client';
import dayjs from 'dayjs';

const api = new Hono();

// Mount all API routes
api.route('/', routes);

const port = parseInt(process.env.APP_PORT || '3000');

/**
 * Helper: run a sync task for all active cabinets.
 * Isolates errors per-cabinet so one failure doesn't stop others.
 */
async function forEachCabinet(
  taskName: string,
  fn: (cabinetId: number, wbClient: ReturnType<typeof getWBClientForCabinet>) => Promise<void>
) {
  const cabinets = await cabinetsRepo.getActiveCabinets();
  for (const cabinet of cabinets) {
    try {
      const wbClient = getWBClientForCabinet(cabinet.id, cabinet.wb_api_key);
      await fn(cabinet.id, wbClient);
      await cabinetsRepo.updateCabinetLastSync(cabinet.id);
    } catch (error: any) {
      console.error(`[Scheduler] ${taskName} failed for cabinet ${cabinet.id} (${cabinet.name}): ${error.message}`);
    }
  }
}

// Register scheduler tasks
scheduler.registerTask('keyword-positions', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Checking keyword positions...');
  await forEachCabinet('keyword-positions', async (cabinetId, wbClient) => {
    const result = await keywordTracker.checkAllPositions(cabinetId, wbClient);
    console.log(`[Scheduler] Cabinet ${cabinetId} keywords checked: ${result.checked}, errors: ${result.errors}`);
  });
});

scheduler.registerTask('sales-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing sales report...');
  const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const dateTo = dayjs().format('YYYY-MM-DD');
  await forEachCabinet('sales-sync', async (cabinetId, wbClient) => {
    const count = await financialService.syncSalesReport(cabinetId, wbClient, dateFrom, dateTo);
    console.log(`[Scheduler] Cabinet ${cabinetId} sales synced: ${count}`);
  });
});

scheduler.registerTask('smart-bidder', 30 * 60 * 1000, async () => {
  console.log('[Scheduler] Running smart bidder...');
  await forEachCabinet('smart-bidder', async (cabinetId, wbClient) => {
    const result = await smartBidder.runAllRules(cabinetId, wbClient);
    console.log(`[Scheduler] Cabinet ${cabinetId} bidder: ${result.campaigns} campaigns, ${result.adjusted} adjusted, ${result.errors} errors`);
  });
});

scheduler.registerTask('campaigns-sync', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing campaigns...');
  await forEachCabinet('campaigns-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('campaigns-sync', undefined, cabinetId);
    try {
      const campaigns = await wbClient.getCampaigns();
      const count = await repo.upsertCampaigns(cabinetId, campaigns);
      await repo.updateImportRecord(importId, 'completed', count);
      console.log(`[Scheduler] Cabinet ${cabinetId} campaigns synced: ${count}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('campaign-stats-sync', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing campaign stats...');
  await forEachCabinet('campaign-stats-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('campaign-stats-sync', undefined, cabinetId);
    try {
      const campaigns = await repo.getCampaigns(cabinetId);
      const campaignIds = campaigns.map(c => c.campaign_id);
      if (campaignIds.length === 0) {
        await repo.updateImportRecord(importId, 'completed', 0);
        return;
      }
      const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
      const dateTo = dayjs().format('YYYY-MM-DD');
      const stats = await wbClient.getCampaignStats(campaignIds, dateFrom, dateTo);
      const count = await repo.upsertCampaignStatsBatch(cabinetId, stats);
      await repo.updateImportRecord(importId, 'completed', count);
      console.log(`[Scheduler] Cabinet ${cabinetId} campaign stats synced: ${count}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('products-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing products...');
  await forEachCabinet('products-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('products-sync', undefined, cabinetId);
    try {
      let totalSynced = 0;
      let errors = 0;
      let cursor: string | undefined;
      while (true) {
        try {
          const result = await wbClient.getProducts(100, cursor);
          const cards = result.cards || [];
          if (cards.length === 0) break;
          for (const card of cards) {
            await repo.upsertProduct(cabinetId, {
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
          console.error(`[Scheduler] Cabinet ${cabinetId} products page error: ${err.message}`);
          break;
        }
      }
      const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
      await repo.updateImportRecord(importId, status, totalSynced);
      console.log(`[Scheduler] Cabinet ${cabinetId} products synced: ${totalSynced}, errors: ${errors}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('product-analytics-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing product analytics...');
  await forEachCabinet('product-analytics-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('product-analytics-sync', undefined, cabinetId);
    try {
      const products = await repo.getProducts(cabinetId);
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
              await repo.upsertProductAnalytics(cabinetId, item, dateFrom);
              totalSynced++;
            }
          }
        } catch (err: any) {
          errors++;
          console.error(`[Scheduler] Cabinet ${cabinetId} product analytics batch error: ${err.message}`);
        }
        if (i + batchSize < products.length) await Bun.sleep(500);
      }
      const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
      await repo.updateImportRecord(importId, status, totalSynced);
      console.log(`[Scheduler] Cabinet ${cabinetId} product analytics synced: ${totalSynced}, errors: ${errors}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('traffic-sources-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing traffic sources...');
  await forEachCabinet('traffic-sources-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('traffic-sources-sync', undefined, cabinetId);
    try {
      const products = await repo.getProducts(cabinetId);
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
            await trafficRepo.upsertTrafficSource(cabinetId, {
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
          console.error(`[Scheduler] Cabinet ${cabinetId} traffic sources batch error: ${err.message}`);
        }
        if (i + batchSize < products.length) await Bun.sleep(500);
      }
      const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
      await repo.updateImportRecord(importId, status, totalSynced);
      console.log(`[Scheduler] Cabinet ${cabinetId} traffic sources synced: ${totalSynced}, errors: ${errors}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('prices-sync', 24 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing prices...');
  await forEachCabinet('prices-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('prices-sync', undefined, cabinetId);
    try {
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
          await repo.upsertProduct(cabinetId, {
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
      console.log(`[Scheduler] Cabinet ${cabinetId} prices synced: ${totalSynced}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('promotions-sync', 24 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing promotions...');
  await forEachCabinet('promotions-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('promotions-sync', undefined, cabinetId);
    try {
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
            await promosRepo.upsertPromoParticipation(cabinetId, {
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
            console.error(`[Scheduler] Cabinet ${cabinetId} promo ${promo.id} error: ${err.message}`);
          }
        }
        await Bun.sleep(600);
      }
      const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
      await repo.updateImportRecord(importId, status, totalSynced);
      console.log(`[Scheduler] Cabinet ${cabinetId} promotions synced: ${totalSynced}, errors: ${errors}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('campaign-products-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing campaign products...');
  await forEachCabinet('campaign-products-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('campaign-products-sync', undefined, cabinetId);
    try {
      const campaigns = await repo.getCampaigns(cabinetId);
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
                await repo.upsertCampaignProduct(cabinetId, campId, nmId);
                totalSynced++;
              }
            }
          }
        } catch (err: any) {
          errors++;
          console.error(`[Scheduler] Cabinet ${cabinetId} campaign products batch error: ${err.message}`);
        }
        if (i + batchSize < campaigns.length) await Bun.sleep(300);
      }
      const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
      await repo.updateImportRecord(importId, status, totalSynced);
      console.log(`[Scheduler] Cabinet ${cabinetId} campaign products synced: ${totalSynced}, errors: ${errors}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('orders-sync', 6 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing orders...');
  await forEachCabinet('orders-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('orders-sync', undefined, cabinetId);
    try {
      const dateFrom = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
      const count = await ordersService.syncOrders(cabinetId, wbClient, dateFrom);
      await repo.updateImportRecord(importId, 'completed', count);
      console.log(`[Scheduler] Cabinet ${cabinetId} orders synced: ${count}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('stocks-sync', 12 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing stocks...');
  await forEachCabinet('stocks-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('stocks-sync', undefined, cabinetId);
    try {
      const count = await stockService.syncStocks(cabinetId, wbClient);
      await repo.updateImportRecord(importId, 'completed', count);
      console.log(`[Scheduler] Cabinet ${cabinetId} stocks synced: ${count}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('search-queries-sync', 24 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing search queries...');
  await forEachCabinet('search-queries-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('search-queries-sync', undefined, cabinetId);
    try {
      const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
      const dateTo = dayjs().format('YYYY-MM-DD');
      const count = await searchService.syncSearchQueries(cabinetId, wbClient, dateFrom, dateTo);
      await repo.updateImportRecord(importId, 'completed', count);
      console.log(`[Scheduler] Cabinet ${cabinetId} search queries synced: ${count}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

scheduler.registerTask('cluster-stats-sync', 24 * 60 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing search cluster stats...');
  await forEachCabinet('cluster-stats-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('cluster-stats-sync', undefined, cabinetId);
    try {
      const count = await searchService.syncSearchClusters(cabinetId, wbClient);
      await repo.updateImportRecord(importId, 'completed', count);
      console.log(`[Scheduler] Cabinet ${cabinetId} cluster stats synced: ${count}`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

// --- Financial sync (expenses + payments + budgets) ---
scheduler.registerTask('financial-sync', 15 * 60 * 1000, async () => {
  console.log('[Scheduler] Syncing financial data (expenses, payments, budgets)...');
  await forEachCabinet('financial-sync', async (cabinetId, wbClient) => {
    const importId = await repo.createImportRecord('financial-sync', undefined, cabinetId);
    try {
      const count = await syncFinancial(cabinetId, wbClient);
      await repo.updateImportRecord(importId, 'completed', count);
      console.log(`[Scheduler] Cabinet ${cabinetId} financial sync: ${count} records`);
    } catch (error: any) {
      await repo.updateImportRecord(importId, 'error', 0, error.message);
      throw error;
    }
  });
});

// Emulator health check
import { healthCheck as emuHealthCheck } from './services/emulator-orchestrator';
scheduler.registerTask('emulator-health-check', 60_000, async () => {
  try {
    await emuHealthCheck();
  } catch (err) {
    console.error('[Scheduler] emulator-health-check failed:', err);
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
║   • /monitoring        - CPS Monitoring               ║
║   • /admin             - Admin Panel                  ║
║                                                       ║
║   New API endpoints:                                  ║
║   • /api/cabinets              - Cabinet management   ║
║   • /api/admin/*               - Admin panel API      ║
║   • /api/products/:id/keywords - Keyword tracking     ║
║   • /api/financial/pnl         - P&L analytics        ║
║   • /api/campaigns/:id/bid-rules - Smart bidder       ║
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
    '/admin': index,
    '/admin/emu-web': index,
    '/emulator': index,
    '/monitoring': index,
  },
  fetch: api.fetch,
  development: process.env.NODE_ENV !== 'production',
});
