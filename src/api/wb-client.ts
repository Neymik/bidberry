import type {
  WBCampaign,
  WBCampaignStats,
  WBBid,
  WBProductAnalytics,
  WBKeywordStat,
} from '../types';

const WB_API_BASE = 'https://advert-api.wildberries.ru';
const WB_ANALYTICS_BASE = 'https://seller-analytics-api.wildberries.ru';
const WB_CONTENT_BASE = 'https://content-api.wildberries.ru';

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
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': this.apiKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WB API Error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  // === ADVERTISING API ===

  // Получить список рекламных кампаний
  async getCampaigns(): Promise<WBCampaign[]> {
    const response = await this.request<{ adverts: WBCampaign[] }>(
      WB_API_BASE,
      '/adv/v1/promotion/count'
    );
    return response.adverts || [];
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
    const response = await this.request<WBCampaignStats[]>(
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
    return response || [];
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

  // === ANALYTICS API ===

  // Получить аналитику по товарам
  async getProductAnalytics(
    nmIds: number[],
    dateFrom: string,
    dateTo: string
  ): Promise<WBProductAnalytics[]> {
    const response = await this.request<{ data: { cards: WBProductAnalytics[] } }>(
      WB_ANALYTICS_BASE,
      '/api/v2/nm-report/detail',
      {
        method: 'POST',
        body: JSON.stringify({
          nmIDs: nmIds,
          period: {
            begin: dateFrom,
            end: dateTo,
          },
        }),
      }
    );
    return response.data?.cards || [];
  }

  // Получить историю продаж
  async getSalesHistory(
    dateFrom: string,
    dateTo: string
  ): Promise<any[]> {
    return this.request<any[]>(
      WB_ANALYTICS_BASE,
      `/api/v1/analytics/nm-report/grouped?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );
  }

  // Получить отчёт по продажам
  async getSalesReport(dateFrom: string, dateTo: string): Promise<any> {
    return this.request<any>(
      WB_ANALYTICS_BASE,
      '/api/v1/analytics/sales-report',
      {
        method: 'POST',
        body: JSON.stringify({
          dateFrom,
          dateTo,
        }),
      }
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
