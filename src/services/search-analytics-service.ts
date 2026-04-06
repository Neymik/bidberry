import type { WBApiClient } from '../api/wb-client';
import * as repo from '../db/repository';
import * as searchRepo from '../db/search-repository';
import dayjs from 'dayjs';

/**
 * Sync search query analytics for all products.
 * Uses WB /api/v2/search-report/product/search-texts endpoint.
 */
export async function syncSearchQueries(
  cabinetId: number,
  wbClient: WBApiClient,
  dateFrom?: string,
  dateTo?: string
): Promise<number> {
  const products = await repo.getProducts(cabinetId);
  if (products.length === 0) return 0;

  const from = dateFrom || dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const to = dateTo || dayjs().format('YYYY-MM-DD');
  let totalSynced = 0;
  const batchSize = 20;

  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    const nmIds = batch.map(p => p.nm_id);

    try {
      const response = await wbClient.getSearchTexts(nmIds, from, to);
      const products_data = response?.data?.products || response?.products || [];

      for (const product of products_data) {
        const nmId = product.nmId || product.nmID || product.nm_id;
        if (!nmId) continue;

        const texts = product.searchTexts || product.texts || [];
        for (const text of texts) {
          await searchRepo.upsertSearchQueryAnalytics(cabinetId, {
            nm_id: nmId,
            keyword: text.text || text.keyword || text.query || '',
            date: from,
            avg_position: text.avgPosition ?? text.position ?? 0,
            impressions: text.openCard ?? text.impressions ?? 0,
            ctr: text.ctr ?? 0,
            card_visits: text.openCard ?? text.cardVisits ?? 0,
            cart_adds: text.addToCart ?? text.cartAdds ?? 0,
            cart_conversion: text.cartConversion ?? 0,
            orders_count: text.orders ?? text.ordersCount ?? 0,
            order_conversion: text.orderConversion ?? 0,
            visibility: text.visibility ?? 0,
          });
          totalSynced++;
        }
      }
    } catch (err: any) {
      console.error(`[search-sync] batch error for nmIds [${nmIds.join(',')}]: ${err.message}`);
    }

    if (i + batchSize < products.length) await Bun.sleep(20_000); // rate limit: 3 req/min
  }

  return totalSynced;
}

/**
 * Sync search cluster stats for all ad campaigns.
 * Uses WB POST /adv/v0/normquery/stats — batches all campaign-product pairs.
 */
export async function syncSearchClusters(
  cabinetId: number,
  wbClient: WBApiClient
): Promise<number> {
  const campaigns = await repo.getCampaigns(cabinetId);
  if (campaigns.length === 0) return 0;

  const dateFrom = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
  const dateTo = dayjs().format('YYYY-MM-DD');

  // Build all (campaign, nm_id) pairs
  const allItems: { advert_id: number; nm_id: number }[] = [];
  for (const campaign of campaigns) {
    const products = await repo.getCampaignProducts(cabinetId, campaign.campaign_id);
    for (const p of products) {
      allItems.push({ advert_id: campaign.campaign_id, nm_id: p.nm_id });
    }
  }

  if (allItems.length === 0) return 0;

  let totalSynced = 0;

  // Batch into chunks (WB allows up to ~20 items per request)
  const batchSize = 20;
  for (let i = 0; i < allItems.length; i += batchSize) {
    const batch = allItems.slice(i, i + batchSize);
    try {
      const stats = await wbClient.getSearchClusterStatsBatch(batch, dateFrom, dateTo);
      if (!Array.isArray(stats)) continue;

      for (const cluster of stats) {
        const clusterName = cluster.cluster || cluster.norm_query || cluster.keyword || cluster.name || '';
        const campaignId = cluster.advert_id || cluster.advertId;
        if (!clusterName || !campaignId) continue;

        await searchRepo.upsertSearchClusterStats(cabinetId, {
          campaign_id: campaignId,
          cluster_name: clusterName,
          date: dateTo,
          views: cluster.views ?? 0,
          clicks: cluster.clicks ?? 0,
          ctr: cluster.ctr ?? 0,
          cpc: cluster.cpc ?? 0,
          cpm: cluster.cpm ?? 0,
          cart_adds: cluster.atbs ?? cluster.cartAdds ?? 0,
          orders_count: cluster.orders ?? 0,
          spend: cluster.sum ?? cluster.spend ?? 0,
        });
        totalSynced++;
      }
    } catch (err: any) {
      console.error(`[search-sync] cluster stats batch error: ${err.message}`);
    }

    if (i + batchSize < allItems.length) await Bun.sleep(6_000);
  }

  return totalSynced;
}
