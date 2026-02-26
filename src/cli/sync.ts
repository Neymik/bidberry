import * as repo from '../db/repository';
import * as trafficRepo from '../db/traffic-repository';
import * as ordersService from '../services/orders-service';
import * as stockService from '../services/stock-service';
import * as financialService from '../services/financial-service';
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
  status: showStatus,
  all: async () => {
    log('Starting full sync...');
    const results: SyncResult[] = [];
    const syncFns = [
      syncCampaigns,
      syncProducts,
      syncAnalytics,
      syncTraffic,
      syncOrders,
      syncStocks,
      syncCampaignStats,
      syncSales,
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
  all            - Run all syncs sequentially
  campaigns      - Sync campaigns only
  products       - Sync products only
  analytics      - Sync product analytics
  traffic        - Sync traffic sources
  orders         - Sync orders
  stocks         - Sync stocks
  stats          - Sync campaign stats
  sales          - Sync sales report
  status         - Show last sync status from import_history
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
