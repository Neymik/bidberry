import * as repo from '../db/repository';
import * as trafficRepo from '../db/traffic-repository';
import * as promosRepo from '../db/promotions-repository';
import * as ordersService from '../services/orders-service';
import * as stockService from '../services/stock-service';
import * as financialService from '../services/financial-service';
import * as searchService from '../services/search-analytics-service';
import { getWBClient } from '../api/wb-client';
import dayjs from 'dayjs';

interface SyncResult {
  target: string;
  synced: number;
  errors: number;
  errorMessages: string[];
}

function log(msg: string) {
  console.log(`[sync] ${msg}`);
}

function logError(msg: string) {
  console.error(`[sync] ${msg}`);
}

async function syncCampaigns(): Promise<SyncResult> {
  log('Syncing campaigns...');
  const importId = await repo.createImportRecord('campaigns-sync');
  try {
    const wbClient = getWBClient();
    const campaigns = await wbClient.getCampaigns();
    const count = await repo.upsertCampaigns(campaigns);
    await repo.updateImportRecord(importId, 'completed', count);
    log(`campaigns: ${count} synced, 0 errors`);
    return { target: 'campaigns', synced: count, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`campaigns: error - ${error.message}`);
    return { target: 'campaigns', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncProducts(): Promise<SyncResult> {
  log('Syncing products...');
  const importId = await repo.createImportRecord('products-sync');
  try {
    const wbClient = getWBClient();
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];
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
        errorMessages.push(err.message);
        logError(`products page error: ${err.message}`);
        break;
      }
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    log(`products: ${totalSynced} synced, ${errors} errors`);
    return { target: 'products', synced: totalSynced, errors, errorMessages };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`products: error - ${error.message}`);
    return { target: 'products', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncAnalytics(): Promise<SyncResult> {
  log('Syncing product analytics...');
  const importId = await repo.createImportRecord('product-analytics-sync');
  try {
    const wbClient = getWBClient();
    const products = await repo.getProducts();
    if (products.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      log('analytics: 0 synced (no products)');
      return { target: 'analytics', synced: 0, errors: 0, errorMessages: [] };
    }

    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];
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
        const batchNum = Math.floor(i / batchSize) + 1;
        errorMessages.push(`Batch ${batchNum}: ${err.message}`);
        logError(`analytics batch ${batchNum} error: ${err.message}`);
      }

      if (i + batchSize < products.length) await Bun.sleep(500);
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    log(`analytics: ${totalSynced} synced, ${errors} errors`);
    return { target: 'analytics', synced: totalSynced, errors, errorMessages };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`analytics: error - ${error.message}`);
    return { target: 'analytics', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncTraffic(): Promise<SyncResult> {
  log('Syncing traffic sources...');
  const importId = await repo.createImportRecord('traffic-sources-sync');
  try {
    const wbClient = getWBClient();
    const products = await repo.getProducts();
    if (products.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      log('traffic: 0 synced (no products)');
      return { target: 'traffic', synced: 0, errors: 0, errorMessages: [] };
    }

    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];
    const batchSize = 20;

    // Known WB traffic source keys from the v3 API response
    const SOURCE_KEYS: Record<string, string> = {
      openByUrl: 'Прямая ссылка',
      openBySearch: 'Поиск',
      openByAdvert: 'Реклама',
      openByRecommend: 'Рекомендации',
      openByCategory: 'Каталог/Категория',
      openByCart: 'Корзина',
      openByOther: 'Прочее',
    };

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

          // Save total row
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

          // Extract per-source breakdown if available
          for (const [key, label] of Object.entries(SOURCE_KEYS)) {
            const sourceViews = stats[key] ?? 0;
            if (sourceViews > 0) {
              await trafficRepo.upsertTrafficSource({
                nm_id: nmId,
                date: dateFrom,
                source_name: label,
                open_card_count: sourceViews,
                add_to_cart_count: 0,
                orders_count: 0,
                orders_sum: 0,
                buyouts_count: 0,
                buyouts_sum: 0,
                cancel_count: 0,
                cancel_sum: 0,
              });
              totalSynced++;
            }
          }
        }
      } catch (err: any) {
        errors++;
        const batchNum = Math.floor(i / batchSize) + 1;
        errorMessages.push(`Batch ${batchNum}: ${err.message}`);
        logError(`traffic batch ${batchNum} error: ${err.message}`);
      }

      if (i + batchSize < products.length) await Bun.sleep(500);
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    log(`traffic: ${totalSynced} synced, ${errors} errors`);
    return { target: 'traffic', synced: totalSynced, errors, errorMessages };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`traffic: error - ${error.message}`);
    return { target: 'traffic', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncPrices(): Promise<SyncResult> {
  log('Syncing prices...');
  const importId = await repo.createImportRecord('prices-sync');
  try {
    const wbClient = getWBClient();
    let totalSynced = 0;
    let offset = 0;
    const limit = 1000;

    while (true) {
      try {
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
      } catch (err: any) {
        logError(`prices page error: ${err.message}`);
        break;
      }
    }

    await repo.updateImportRecord(importId, 'completed', totalSynced);
    log(`prices: ${totalSynced} synced`);
    return { target: 'prices', synced: totalSynced, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`prices: error - ${error.message}`);
    return { target: 'prices', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncPromotions(): Promise<SyncResult> {
  log('Syncing promotions...');
  const importId = await repo.createImportRecord('promotions-sync');
  try {
    const wbClient = getWBClient();
    const promotions = await wbClient.getPromotions();
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];

    // Skip "auto" type promos — nomenclatures endpoint doesn't work for them
    const eligiblePromos = promotions.filter((p: any) => p.type !== 'auto');
    log(`Found ${promotions.length} promos (${eligiblePromos.length} eligible, ${promotions.length - eligiblePromos.length} auto-skipped)`);

    for (const promo of eligiblePromos) {
      try {
        const nomenclatures = await wbClient.getPromotionNomenclatures(promo.id);
        const participatingNmIds = new Set(nomenclatures.map((n: any) => n.nmID || n.nmId));

        for (const nmId of participatingNmIds) {
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
        // 422 = promo expired/not available for nomenclatures — not a real error
        if (err.message?.includes('422')) {
          log(`promo ${promo.id} skipped (422 - not available for nomenclature listing)`);
        } else {
          errors++;
          errorMessages.push(`Promo ${promo.id}: ${err.message}`);
          logError(`promo ${promo.id} error: ${err.message}`);
        }
      }

      // Rate limit: 10 req / 6 sec
      await Bun.sleep(600);
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    log(`promotions: ${totalSynced} synced, ${errors} errors`);
    return { target: 'promotions', synced: totalSynced, errors, errorMessages };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`promotions: error - ${error.message}`);
    return { target: 'promotions', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncCampaignProducts(): Promise<SyncResult> {
  log('Syncing campaign products...');
  const importId = await repo.createImportRecord('campaign-products-sync');
  try {
    const wbClient = getWBClient();
    const campaigns = await repo.getCampaigns();
    let totalSynced = 0;
    let errors = 0;
    const errorMessages: string[] = [];

    // Process in batches of 50 (API limit)
    const batchSize = 50;
    for (let i = 0; i < campaigns.length; i += batchSize) {
      const batch = campaigns.slice(i, i + batchSize);
      const campaignIds = batch.map(c => c.campaign_id);
      try {
        const adverts = await wbClient.getCampaignsInfo(campaignIds);
        for (const advert of adverts) {
          const campId = advert.id || advert.advertId;
          if (!campId) continue;
          // Extract nm_ids from nm_settings array
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
        const batchNum = Math.floor(i / batchSize) + 1;
        errorMessages.push(`Batch ${batchNum}: ${err.message}`);
        logError(`campaign-products batch ${batchNum} error: ${err.message}`);
      }
      if (i + batchSize < campaigns.length) await Bun.sleep(300);
    }

    const status = errors > 0 ? (totalSynced > 0 ? 'partial' : 'error') : 'completed';
    await repo.updateImportRecord(importId, status, totalSynced, errorMessages.join('; ') || undefined);
    log(`campaign-products: ${totalSynced} synced, ${errors} errors`);
    return { target: 'campaign-products', synced: totalSynced, errors, errorMessages };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`campaign-products: error - ${error.message}`);
    return { target: 'campaign-products', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncOrders(): Promise<SyncResult> {
  log('Syncing orders...');
  const importId = await repo.createImportRecord('orders-sync');
  try {
    const dateFrom = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
    const count = await ordersService.syncOrders(dateFrom);
    await repo.updateImportRecord(importId, 'completed', count);
    log(`orders: ${count} synced, 0 errors`);
    return { target: 'orders', synced: count, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`orders: error - ${error.message}`);
    return { target: 'orders', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncStocks(): Promise<SyncResult> {
  log('Syncing stocks...');
  const importId = await repo.createImportRecord('stocks-sync');
  try {
    const count = await stockService.syncStocks();
    await repo.updateImportRecord(importId, 'completed', count);
    log(`stocks: ${count} synced, 0 errors`);
    return { target: 'stocks', synced: count, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`stocks: error - ${error.message}`);
    return { target: 'stocks', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncCampaignStats(): Promise<SyncResult> {
  log('Syncing campaign stats...');
  const importId = await repo.createImportRecord('campaign-stats-sync');
  try {
    const wbClient = getWBClient();
    const campaigns = await repo.getCampaigns();
    const campaignIds = campaigns.map(c => c.campaign_id);
    if (campaignIds.length === 0) {
      await repo.updateImportRecord(importId, 'completed', 0);
      log('stats: 0 synced (no campaigns)');
      return { target: 'stats', synced: 0, errors: 0, errorMessages: [] };
    }
    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    const stats = await wbClient.getCampaignStats(campaignIds, dateFrom, dateTo);
    const count = await repo.upsertCampaignStatsBatch(stats);
    await repo.updateImportRecord(importId, 'completed', count);
    log(`stats: ${count} synced, 0 errors`);
    return { target: 'stats', synced: count, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`stats: error - ${error.message}`);
    return { target: 'stats', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncSales(): Promise<SyncResult> {
  log('Syncing sales report...');
  const importId = await repo.createImportRecord('sales-sync');
  try {
    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    const count = await financialService.syncSalesReport(dateFrom, dateTo);
    await repo.updateImportRecord(importId, 'completed', count);
    log(`sales: ${count} synced, 0 errors`);
    return { target: 'sales', synced: count, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`sales: error - ${error.message}`);
    return { target: 'sales', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncSearchQueries(): Promise<SyncResult> {
  log('Syncing search queries...');
  const importId = await repo.createImportRecord('search-queries-sync');
  try {
    const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const dateTo = dayjs().format('YYYY-MM-DD');
    const count = await searchService.syncSearchQueries(dateFrom, dateTo);
    await repo.updateImportRecord(importId, 'completed', count);
    log(`search-queries: ${count} synced, 0 errors`);
    return { target: 'search-queries', synced: count, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`search-queries: error - ${error.message}`);
    return { target: 'search-queries', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function syncClusterStats(): Promise<SyncResult> {
  log('Syncing search cluster stats...');
  const importId = await repo.createImportRecord('cluster-stats-sync');
  try {
    const count = await searchService.syncSearchClusters();
    await repo.updateImportRecord(importId, 'completed', count);
    log(`cluster-stats: ${count} synced, 0 errors`);
    return { target: 'cluster-stats', synced: count, errors: 0, errorMessages: [] };
  } catch (error: any) {
    await repo.updateImportRecord(importId, 'error', 0, error.message);
    logError(`cluster-stats: error - ${error.message}`);
    return { target: 'cluster-stats', synced: 0, errors: 1, errorMessages: [error.message] };
  }
}

async function showStatus(): Promise<void> {
  const history = await repo.getImportHistory(20);
  if (history.length === 0) {
    log('No sync history found.');
    return;
  }

  console.log('\n[sync] Recent sync history:');
  console.log('-'.repeat(90));
  console.log(
    'Type'.padEnd(25) +
    'Status'.padEnd(12) +
    'Records'.padEnd(10) +
    'Started'.padEnd(22) +
    'Error'
  );
  console.log('-'.repeat(90));

  for (const record of history) {
    const started = record.started_at
      ? dayjs(record.started_at).format('YYYY-MM-DD HH:mm:ss')
      : '-';
    const errorMsg = record.error_message
      ? record.error_message.substring(0, 30)
      : '';
    console.log(
      String(record.import_type || '').padEnd(25) +
      String(record.status || '').padEnd(12) +
      String(record.records_count ?? '-').padEnd(10) +
      started.padEnd(22) +
      errorMsg
    );
  }
  console.log('-'.repeat(90));
}

const COMMANDS: Record<string, () => Promise<SyncResult | SyncResult[] | void>> = {
  campaigns: syncCampaigns,
  products: syncProducts,
  analytics: syncAnalytics,
  traffic: syncTraffic,
  orders: syncOrders,
  stocks: syncStocks,
  stats: syncCampaignStats,
  sales: syncSales,
  prices: syncPrices,
  promotions: syncPromotions,
  'campaign-products': syncCampaignProducts,
  'search-queries': syncSearchQueries,
  'cluster-stats': syncClusterStats,
  status: showStatus,
  all: async () => {
    log('Starting full sync...');
    const results: SyncResult[] = [];
    const syncFns = [
      syncCampaigns,
      syncProducts,
      syncPrices,
      syncAnalytics,
      syncTraffic,
      syncOrders,
      syncStocks,
      syncCampaignStats,
      syncSales,
      syncPromotions,
      syncCampaignProducts,
      syncSearchQueries,
      syncClusterStats,
    ];

    for (const fn of syncFns) {
      const result = await fn();
      results.push(result);
    }

    const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

    log(`Complete. Total: ${totalSynced} synced, ${totalErrors} errors`);
    console.log(JSON.stringify({ synced: totalSynced, errors: totalErrors, details: results }));
    return results;
  },
};

const USAGE = `
Usage: bun run src/cli/sync.ts [command]

Commands:
  all              - Run all syncs sequentially
  campaigns        - Sync campaigns only
  products         - Sync products only
  prices           - Sync product prices
  analytics        - Sync product analytics
  traffic          - Sync traffic sources
  orders           - Sync orders
  stocks           - Sync stocks
  stats            - Sync campaign stats
  sales            - Sync sales report
  promotions       - Sync promotion participation
  campaign-products - Sync campaign→product links
  search-queries   - Sync search query analytics
  cluster-stats    - Sync search cluster stats for campaigns
  status           - Show last sync status from import_history
`;

async function main() {
  const command = process.argv[2];

  if (!command || !COMMANDS[command]) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  try {
    const result = await COMMANDS[command]();

    // Determine exit code
    if (command === 'status') {
      process.exit(0);
    }

    if (Array.isArray(result)) {
      // 'all' command
      const totalErrors = result.reduce((sum, r) => sum + r.errors, 0);
      const totalSynced = result.reduce((sum, r) => sum + r.synced, 0);
      if (totalErrors > 0 && totalSynced === 0) process.exit(2);
      if (totalErrors > 0) process.exit(1);
      process.exit(0);
    }

    if (result) {
      if (result.errors > 0 && result.synced === 0) process.exit(2);
      if (result.errors > 0) process.exit(1);
    }
    process.exit(0);
  } catch (error: any) {
    logError(`Fatal error: ${error.message}`);
    process.exit(2);
  }
}

main();
