import { getWBClient } from '../api/wb-client';
import * as repo from '../db/repository';
import * as searchRepo from '../db/search-repository';
import dayjs from 'dayjs';

/**
 * Sync search query analytics for all products.
 * Uses WB /api/v2/search-report/product/search-texts endpoint.
 */
export async function syncSearchQueries(
  dateFrom?: string,
  dateTo?: string
): Promise<number> {
  const wbClient = getWBClient();
  const products = await repo.getProducts();
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
          await searchRepo.upsertSearchQueryAnalytics({
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
 * Uses WB /adv/v0/normquery/stats endpoint per campaign.
 */
export async function syncSearchClusters(): Promise<number> {
  const wbClient = getWBClient();
  const campaigns = await repo.getCampaigns();
  if (campaigns.length === 0) return 0;

  let totalSynced = 0;
  const today = dayjs().format('YYYY-MM-DD');

  for (const campaign of campaigns) {
    try {
      const stats = await wbClient.getSearchClusterStats(campaign.campaign_id);
      if (!Array.isArray(stats)) continue;

      for (const cluster of stats) {
        const clusterName = cluster.cluster || cluster.keyword || cluster.name || '';
        if (!clusterName) continue;

        await searchRepo.upsertSearchClusterStats({
          campaign_id: campaign.campaign_id,
          cluster_name: clusterName,
          date: today,
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
      console.error(`[search-sync] cluster stats error for campaign ${campaign.campaign_id}: ${err.message}`);
    }

    await Bun.sleep(500); // rate limit between campaigns
  }

  return totalSynced;
}
