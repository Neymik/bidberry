// Wildberries API Types

// Рекламные кампании
export interface WBCampaign {
  advertId: number;
  name: string;
  type: number;
  status: number;
  dailyBudget: number;
  createTime: string;
  changeTime: string;
  startTime: string;
  endTime: string;
}

export interface WBCampaignListResponse {
  adverts: WBCampaign[];
}

// Статистика кампаний
export interface WBCampaignStats {
  advertId: number;
  date: string;
  views: number;
  clicks: number;
  ctr: number;
  cpc: number;
  spend: number;
  orders: number;
  ordersSumRub: number;
  atbs: number;
  shks: number;
  sumPrice: number;
}

export interface WBCampaignStatsResponse {
  days: WBCampaignStats[];
}

// Ставки (Bidding)
export interface WBBid {
  keyword: string;
  bid: number;
  position: number;
  cpm: number;
}

export interface WBBiddingResponse {
  bids: WBBid[];
}

// Аналитика товаров
export interface WBProductAnalytics {
  nmID: number;
  vendorCode: string;
  brandName: string;
  tags: {
    subject: string;
  };
  object: {
    name: string;
  };
  statistics: {
    selectedPeriod: {
      begin: string;
      end: string;
      openCardCount: number;
      addToCartCount: number;
      ordersCount: number;
      ordersSumRub: number;
      buyoutsCount: number;
      buyoutsSumRub: number;
      cancelCount: number;
      cancelSumRub: number;
    };
    previousPeriod: {
      begin: string;
      end: string;
      openCardCount: number;
      addToCartCount: number;
      ordersCount: number;
      ordersSumRub: number;
      buyoutsCount: number;
      buyoutsSumRub: number;
      cancelCount: number;
      cancelSumRub: number;
    };
  };
  stocks: {
    stocksMp: number;
    stocksWb: number;
  };
}

export interface WBAnalyticsResponse {
  data: {
    cards: WBProductAnalytics[];
  };
}

// Ключевые слова
export interface WBKeywordStat {
  keyword: string;
  freq: number;
}

export interface WBKeywordPosition {
  keyword: string;
  position: number;
  page: number;
}

// Database Models
export interface DBCampaign {
  id: number;
  campaign_id: number;
  name: string;
  type: string;
  status: string;
  start_date: Date;
  end_date: Date;
  daily_budget: number;
  created_at: Date;
  updated_at: Date;
}

export interface DBCampaignStats {
  id: number;
  campaign_id: number;
  date: Date;
  views: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  spend: number;
  orders: number;
  order_sum: number;
  atbs: number;
  shks: number;
  sum_price: number;
  created_at: Date;
}

export interface DBProduct {
  id: number;
  nm_id: number;
  vendor_code: string;
  brand: string;
  subject: string;
  name: string;
  price: number;
  discount: number;
  final_price: number;
  rating: number;
  feedbacks: number;
  created_at: Date;
  updated_at: Date;
}

export interface DBProductAnalytics {
  id: number;
  nm_id: number;
  date: Date;
  open_card_count: number;
  add_to_cart_count: number;
  orders_count: number;
  orders_sum: number;
  buyouts_count: number;
  buyouts_sum: number;
  cancel_count: number;
  cancel_sum: number;
  conversion_to_cart: number;
  conversion_to_order: number;
  created_at: Date;
}

// Excel Export Types
export interface ExcelCampaignRow {
  'ID Кампании': number;
  'Название': string;
  'Тип': string;
  'Статус': string;
  'Дневной бюджет': number;
  'Показы': number;
  'Клики': number;
  'CTR, %': number;
  'CPC': number;
  'Расход': number;
  'Заказы': number;
  'Сумма заказов': number;
  'ROAS': number;
}

export interface ExcelProductRow {
  'Артикул WB': number;
  'Артикул продавца': string;
  'Бренд': string;
  'Категория': string;
  'Название': string;
  'Просмотры карточки': number;
  'В корзину': number;
  'Заказы': number;
  'Сумма заказов': number;
  'Выкупы': number;
  'Сумма выкупов': number;
  'Отмены': number;
  'Конверсия в корзину, %': number;
  'Конверсия в заказ, %': number;
}

// API Request Types
export interface DateRangeRequest {
  dateFrom: string;
  dateTo: string;
}

export interface PaginationRequest {
  page?: number;
  limit?: number;
}

// Summary types
export interface DailySummary {
  date: string;
  campaigns_count: number;
  total_views: number;
  total_clicks: number;
  avg_ctr: number;
  total_spend: number;
  total_orders: number;
  total_order_sum: number;
  roas: number;
}

export interface AnalyticsSummary {
  totalCampaigns: number;
  activeCampaigns: number;
  totalSpend: number;
  totalOrders: number;
  totalRevenue: number;
  avgCTR: number;
  avgCPC: number;
  roas: number;
  period: {
    from: string;
    to: string;
  };
}
