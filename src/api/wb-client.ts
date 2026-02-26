import type {
  WBCampaign,
  WBCampaignStats,
  WBBid,
  WBProductAnalytics,
  WBKeywordStat,
  WBOrder,
  WBStock,
} from '../types';
import { withRetry } from '../utils/retry';

const WB_API_BASE = 'https://advert-api.wildberries.ru';
const WB_ANALYTICS_BASE = 'https://seller-analytics-api.wildberries.ru';
const WB_CONTENT_BASE = 'https://content-api.wildberries.ru';
const WB_STATISTICS_BASE = 'https://statistics-api.wildberries.ru';

export class WBApiClient {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.WB_API_KEY || '';
    if (!this.apiKey) {
      console.warn('WB_API_KEY is not set. API calls will fail.');
    }
  }

  private async request<T>(
    baseUrl: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${baseUrl}${endpoint}`;
    return withRetry(
      async () => {
        const response = await fetch(url, {
          ...options,
          headers: {
            'Authorization': this.apiKey,
            'Content-Type': 'application/json',
            ...options.headers,
          },
          signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`WB API Error: ${response.status} - ${error}`);
        }

        return response.json();
      },
      {
        onRetry: (error, attempt, delayMs) => {
          console.warn(
            `[WB API] Retry ${attempt}/3 for ${endpoint}: ${error.message}. Waiting ${delayMs}ms...`
          );
        },
      }
    );
  }

  // === ADVERTISING API ===

  // Получить список рекламных кампаний
  async getCampaigns(): Promise<WBCampaign[]> {
    const response = await this.request<{
      adverts: {
        type: number;
        status: number;
        count: number;
        advert_list: { advertId: number; changeTime: string }[];
      }[];
    }>(
      WB_API_BASE,
      '/adv/v1/promotion/count'
    );

    // Flatten grouped structure into flat campaign list
    const campaigns: WBCampaign[] = [];
    for (const group of response.adverts || []) {
      for (const advert of group.advert_list || []) {
        campaigns.push({
          advertId: advert.advertId,
          name: '',
          type: group.type,
          status: group.status,
          dailyBudget: 0,
          createTime: '',
          changeTime: advert.changeTime,
          startTime: '',
          endTime: '',
        });
      }
    }
    return campaigns;
  }

  // Получить информацию о кампании
  async getCampaignInfo(campaignId: number): Promise<WBCampaign> {
    return this.request<WBCampaign>(
      WB_API_BASE,
      `/adv/v1/promotion/adverts?id=${campaignId}`
    );
  }

  // Получить статистику кампаний
  async getCampaignStats(
    campaignIds: number[],
    dateFrom: string,
    dateTo: string
  ): Promise<WBCampaignStats[]> {
    const response = await this.request<any[]>(
      WB_API_BASE,
      '/adv/v2/fullstats',
      {
        method: 'POST',
        body: JSON.stringify(campaignIds.map(id => ({
          id,
          dates: [dateFrom, dateTo],
        }))),
      }
    );

    // Flatten: each campaign response has days[] with per-day stats
    const result: WBCampaignStats[] = [];
    for (const campaign of response || []) {
      const advertId = campaign.advertId;
      if (!advertId) continue;

      for (const day of campaign.days || []) {
        if (!day.date) continue;
        // Aggregate across all apps within the day
        let views = 0, clicks = 0, spend = 0, atbs = 0, orders = 0, shks = 0, sumPrice = 0;
        for (const app of day.apps || []) {
          views += app.views ?? 0;
          clicks += app.clicks ?? 0;
          spend += app.sum ?? 0;
          atbs += app.atbs ?? 0;
          orders += app.orders ?? 0;
          shks += app.shks ?? 0;
          sumPrice += app.sum_price ?? 0;
        }
        const ctr = views > 0 ? (clicks / views) * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;

        result.push({
          advertId,
          date: day.date.split('T')[0],
          views,
          clicks,
          ctr: Math.round(ctr * 100) / 100,
          cpc: Math.round(cpc * 100) / 100,
          spend,
          orders,
          ordersSumRub: sumPrice,
          atbs,
          shks,
          sumPrice,
        });
      }
    }
    return result;
  }

  // Получить ставки для кампании (Bidding)
  async getBids(campaignId: number): Promise<WBBid[]> {
    const response = await this.request<{ bids: WBBid[] }>(
      WB_API_BASE,
      `/adv/v1/stat/words?id=${campaignId}`
    );
    return response.bids || [];
  }

  // Установить ставку
  async setBid(
    campaignId: number,
    keyword: string,
    bid: number
  ): Promise<void> {
    await this.request(
      WB_API_BASE,
      '/adv/v1/bid',
      {
        method: 'POST',
        body: JSON.stringify({
          advertId: campaignId,
          param: keyword,
          price: bid,
        }),
      }
    );
  }

  // Получить автоматические ставки
  async getAutoBids(campaignId: number): Promise<{ cpm: number; budget: number }> {
    return this.request<{ cpm: number; budget: number }>(
      WB_API_BASE,
      `/adv/v1/auto/budget?id=${campaignId}`
    );
  }

  // === ANALYTICS API (v3 Sales Funnel) ===

  // Получить аналитику по товарам (v3 sales-funnel)
  async getProductAnalytics(
    nmIds: number[],
    dateFrom: string,
    dateTo: string
  ): Promise<WBProductAnalytics[]> {
    const response = await this.request<{ data: { products: any[] } }>(
      WB_ANALYTICS_BASE,
      '/api/analytics/v3/sales-funnel/products',
      {
        method: 'POST',
        body: JSON.stringify({
          nmIDs: nmIds,
          selectedPeriod: { start: dateFrom, end: dateTo },
        }),
      }
    );

    // Map v3 response to existing WBProductAnalytics interface
    return (response.data?.products || []).map((item: any) => ({
      nmID: item.product?.nmId,
      vendorCode: item.product?.vendorCode || '',
      brandName: item.product?.brandName || '',
      tags: { subject: item.product?.subjectName || '' },
      object: { name: item.product?.title || '' },
      statistics: {
        selectedPeriod: {
          begin: dateFrom,
          end: dateTo,
          openCardCount: item.statistic?.selected?.openCount ?? 0,
          addToCartCount: item.statistic?.selected?.cartCount ?? 0,
          ordersCount: item.statistic?.selected?.orderCount ?? 0,
          ordersSumRub: item.statistic?.selected?.orderSum ?? 0,
          buyoutsCount: item.statistic?.selected?.buyoutCount ?? 0,
          buyoutsSumRub: item.statistic?.selected?.buyoutSum ?? 0,
          cancelCount: item.statistic?.selected?.cancelCount ?? 0,
          cancelSumRub: item.statistic?.selected?.cancelSum ?? 0,
        },
        previousPeriod: {
          begin: '',
          end: '',
          openCardCount: item.statistic?.past?.openCount ?? 0,
          addToCartCount: item.statistic?.past?.cartCount ?? 0,
          ordersCount: item.statistic?.past?.orderCount ?? 0,
          ordersSumRub: item.statistic?.past?.orderSum ?? 0,
          buyoutsCount: item.statistic?.past?.buyoutCount ?? 0,
          buyoutsSumRub: item.statistic?.past?.buyoutSum ?? 0,
          cancelCount: item.statistic?.past?.cancelCount ?? 0,
          cancelSumRub: item.statistic?.past?.cancelSum ?? 0,
        },
      },
      stocks: {
        stocksMp: item.product?.stocks?.mp ?? 0,
        stocksWb: item.product?.stocks?.wb ?? 0,
      },
    }));
  }

  // Получить историю продаж (v3 sales-funnel grouped history)
  async getSalesHistory(
    dateFrom: string,
    dateTo: string
  ): Promise<any[]> {
    return this.request<any[]>(
      WB_ANALYTICS_BASE,
      '/api/analytics/v3/sales-funnel/grouped/history',
      {
        method: 'POST',
        body: JSON.stringify({
          selectedPeriod: { start: dateFrom, end: dateTo },
        }),
      }
    );
  }

  // Получить отчёт по продажам (Statistics API — /api/v1/supplier/sales)
  async getSalesReport(dateFrom: string, _dateTo: string): Promise<any> {
    return this.request<any>(
      WB_STATISTICS_BASE,
      `/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFrom)}`
    );
  }

  // === CONTENT API ===

  // Получить список товаров
  async getProducts(limit = 100, cursor?: string): Promise<{
    cards: any[];
    cursor: { nmID: number; updatedAt: string } | null;
  }> {
    const body: any = {
      settings: {
        cursor: cursor ? JSON.parse(cursor) : { limit },
        filter: { withPhoto: -1 },
      },
    };

    return this.request<{
      cards: any[];
      cursor: { nmID: number; updatedAt: string } | null;
    }>(
      WB_CONTENT_BASE,
      '/content/v2/get/cards/list',
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
  }

  // Получить информацию о товаре по nmId
  async getProductInfo(nmIds: number[]): Promise<any[]> {
    return this.request<any[]>(
      WB_CONTENT_BASE,
      '/content/v2/get/cards/list',
      {
        method: 'POST',
        body: JSON.stringify({
          settings: {
            filter: { nmIDs: nmIds },
          },
        }),
      }
    );
  }

  // === KEYWORDS API ===

  // Получить ключевые слова для товара
  async getKeywordStats(keyword: string): Promise<WBKeywordStat[]> {
    // Использует внешний сервис или WB API для получения частотности
    const response = await this.request<{ keywords: WBKeywordStat[] }>(
      WB_API_BASE,
      `/adv/v1/search/keywords?keyword=${encodeURIComponent(keyword)}`
    );
    return response.keywords || [];
  }

  // Получить рекомендуемые ключевые слова
  async getRecommendedKeywords(nmId: number): Promise<string[]> {
    const response = await this.request<{ keywords: string[] }>(
      WB_API_BASE,
      `/adv/v1/search/recommendation?nmId=${nmId}`
    );
    return response.keywords || [];
  }

  // === ORDERS API (Statistics) ===

  // Получить заказы (Marketplace Statistics API)
  async getOrders(dateFrom: string): Promise<WBOrder[]> {
    return this.request<WBOrder[]>(
      WB_STATISTICS_BASE,
      `/api/v1/supplier/orders?dateFrom=${encodeURIComponent(dateFrom)}`
    );
  }

  // === STOCKS API (Statistics) ===

  // Получить остатки на складах
  async getStocks(dateFrom: string): Promise<WBStock[]> {
    return this.request<WBStock[]>(
      WB_STATISTICS_BASE,
      `/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(dateFrom)}`
    );
  }

  // === ANALYTICS API (Enhanced — with conversion data) ===

  // Получить детальную аналитику по товарам с конверсиями (v3 sales-funnel)
  async getProductAnalyticsDetailed(
    nmIds: number[],
    dateFrom: string,
    dateTo: string
  ): Promise<any> {
    return this.request<any>(
      WB_ANALYTICS_BASE,
      '/api/analytics/v3/sales-funnel/products',
      {
        method: 'POST',
        body: JSON.stringify({
          nmIDs: nmIds,
          selectedPeriod: { start: dateFrom, end: dateTo },
        }),
      }
    );
  }

  // === BUDGET API ===

  // Получить баланс рекламного кабинета
  async getBalance(): Promise<{ balance: number; bonus: number }> {
    return this.request<{ balance: number; bonus: number }>(
      WB_API_BASE,
      '/adv/v1/balance'
    );
  }

  // Получить бюджет кампании
  async getCampaignBudget(campaignId: number): Promise<{ budget: number; dailyBudget: number }> {
    return this.request<{ budget: number; dailyBudget: number }>(
      WB_API_BASE,
      `/adv/v1/budget?id=${campaignId}`
    );
  }

  // Установить бюджет кампании
  async setCampaignBudget(campaignId: number, budget: number): Promise<void> {
    await this.request(
      WB_API_BASE,
      '/adv/v1/budget/deposit',
      {
        method: 'POST',
        body: JSON.stringify({
          advertId: campaignId,
          sum: budget,
        }),
      }
    );
  }

  // === UTILITY METHODS ===

  // Проверить подключение к API
  async checkConnection(): Promise<boolean> {
    try {
      await this.getBalance();
      return true;
    } catch {
      return false;
    }
  }

  // Получить все данные для дашборда
  async getDashboardData(dateFrom: string, dateTo: string): Promise<{
    campaigns: WBCampaign[];
    stats: WBCampaignStats[];
    balance: { balance: number; bonus: number };
  }> {
    const [campaigns, balance] = await Promise.all([
      this.getCampaigns(),
      this.getBalance(),
    ]);

    const campaignIds = campaigns.map(c => c.advertId);
    let stats: WBCampaignStats[] = [];

    if (campaignIds.length > 0) {
      stats = await this.getCampaignStats(campaignIds, dateFrom, dateTo);
    }

    return { campaigns, stats, balance };
  }
}

// Singleton instance
let clientInstance: WBApiClient | null = null;

export function getWBClient(apiKey?: string): WBApiClient {
  if (!clientInstance || apiKey) {
    clientInstance = new WBApiClient(apiKey);
  }
  return clientInstance;
}
