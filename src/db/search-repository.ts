import { query, execute } from './connection';

export interface DBSearchQueryAnalytics {
  id: number;
  nm_id: number;
  keyword: string;
  date: Date;
  avg_position: number;
  impressions: number;
  ctr: number;
  card_visits: number;
  cart_adds: number;
  cart_conversion: number;
  orders_count: number;
  order_conversion: number;
  visibility: number;
  current_price: number;
  created_at: Date;
}

export interface DBSearchClusterStats {
  id: number;
  campaign_id: number;
  cluster_name: string;
  date: Date;
  views: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  cart_adds: number;
  orders_count: number;
  spend: number;
  created_at: Date;
}

export async function upsertSearchQueryAnalytics(data: {
  nm_id: number;
  keyword: string;
  date: string;
  avg_position?: number;
  impressions?: number;
  ctr?: number;
  card_visits?: number;
  cart_adds?: number;
  cart_conversion?: number;
  orders_count?: number;
  order_conversion?: number;
  visibility?: number;
  current_price?: number;
}): Promise<void> {
  await execute(
    `INSERT INTO search_query_analytics
      (nm_id, keyword, date, avg_position, impressions, ctr, card_visits,
       cart_adds, cart_conversion, orders_count, order_conversion, visibility, current_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       avg_position = VALUES(avg_position),
       impressions = VALUES(impressions),
       ctr = VALUES(ctr),
       card_visits = VALUES(card_visits),
       cart_adds = VALUES(cart_adds),
       cart_conversion = VALUES(cart_conversion),
       orders_count = VALUES(orders_count),
       order_conversion = VALUES(order_conversion),
       visibility = VALUES(visibility),
       current_price = VALUES(current_price)`,
    [
      data.nm_id,
      data.keyword,
      data.date,
      data.avg_position ?? 0,
      data.impressions ?? 0,
      data.ctr ?? 0,
      data.card_visits ?? 0,
      data.cart_adds ?? 0,
      data.cart_conversion ?? 0,
      data.orders_count ?? 0,
      data.order_conversion ?? 0,
      data.visibility ?? 0,
      data.current_price ?? 0,
    ]
  );
}

export async function upsertSearchClusterStats(data: {
  campaign_id: number;
  cluster_name: string;
  date: string;
  views?: number;
  clicks?: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
  cart_adds?: number;
  orders_count?: number;
  spend?: number;
}): Promise<void> {
  await execute(
    `INSERT INTO search_cluster_stats
      (campaign_id, cluster_name, date, views, clicks, ctr, cpc, cpm, cart_adds, orders_count, spend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       views = VALUES(views),
       clicks = VALUES(clicks),
       ctr = VALUES(ctr),
       cpc = VALUES(cpc),
       cpm = VALUES(cpm),
       cart_adds = VALUES(cart_adds),
       orders_count = VALUES(orders_count),
       spend = VALUES(spend)`,
    [
      data.campaign_id,
      data.cluster_name,
      data.date,
      data.views ?? 0,
      data.clicks ?? 0,
      data.ctr ?? 0,
      data.cpc ?? 0,
      data.cpm ?? 0,
      data.cart_adds ?? 0,
      data.orders_count ?? 0,
      data.spend ?? 0,
    ]
  );
}

export async function getSearchQueryAnalytics(
  nmId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBSearchQueryAnalytics[]> {
  let sql = 'SELECT * FROM search_query_analytics WHERE nm_id = ?';
  const params: any[] = [nmId];
  if (dateFrom) { sql += ' AND date >= ?'; params.push(dateFrom); }
  if (dateTo) { sql += ' AND date <= ?'; params.push(dateTo); }
  sql += ' ORDER BY date DESC, impressions DESC';
  return query<DBSearchQueryAnalytics[]>(sql, params);
}

export async function getSearchQuerySummary(
  nmId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<any[]> {
  let sql = `
    SELECT
      keyword,
      ROUND(AVG(avg_position), 1) as avg_position,
      SUM(impressions) as total_impressions,
      SUM(card_visits) as total_visits,
      SUM(cart_adds) as total_cart_adds,
      SUM(orders_count) as total_orders,
      ROUND(AVG(ctr) * 100, 2) as avg_ctr,
      ROUND(AVG(visibility) * 100, 2) as avg_visibility
    FROM search_query_analytics
    WHERE nm_id = ?
  `;
  const params: any[] = [nmId];
  if (dateFrom) { sql += ' AND date >= ?'; params.push(dateFrom); }
  if (dateTo) { sql += ' AND date <= ?'; params.push(dateTo); }
  sql += ' GROUP BY keyword ORDER BY total_impressions DESC';
  return query<any[]>(sql, params);
}

export async function getAllSearchQuerySummary(
  dateFrom?: string,
  dateTo?: string
): Promise<any[]> {
  let sql = `
    SELECT
      nm_id,
      keyword,
      ROUND(AVG(avg_position), 1) as avg_position,
      SUM(impressions) as total_impressions,
      SUM(card_visits) as total_visits,
      SUM(cart_adds) as total_cart_adds,
      SUM(orders_count) as total_orders,
      ROUND(AVG(ctr) * 100, 2) as avg_ctr,
      ROUND(AVG(visibility) * 100, 2) as avg_visibility
    FROM search_query_analytics
    WHERE 1=1
  `;
  const params: any[] = [];
  if (dateFrom) { sql += ' AND date >= ?'; params.push(dateFrom); }
  if (dateTo) { sql += ' AND date <= ?'; params.push(dateTo); }
  sql += ' GROUP BY nm_id, keyword ORDER BY nm_id, total_impressions DESC';
  return query<any[]>(sql, params);
}

export async function getSearchClusterStatsByCampaign(
  campaignId: number,
  dateFrom?: string,
  dateTo?: string
): Promise<DBSearchClusterStats[]> {
  let sql = 'SELECT * FROM search_cluster_stats WHERE campaign_id = ?';
  const params: any[] = [campaignId];
  if (dateFrom) { sql += ' AND date >= ?'; params.push(dateFrom); }
  if (dateTo) { sql += ' AND date <= ?'; params.push(dateTo); }
  sql += ' ORDER BY date DESC, views DESC';
  return query<DBSearchClusterStats[]>(sql, params);
}
