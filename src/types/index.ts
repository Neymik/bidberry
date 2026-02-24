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

// === KEYWORD TRACKING ===

export interface DBKeywordCollection {
  id: number;
  nm_id: number;
  keyword: string;
  frequency: number;
  is_tracked: boolean;
  source: string;
  created_at: Date;
  updated_at: Date;
}

export interface DBKeywordPosition {
  id: number;
  nm_id: number;
  keyword: string;
  position: number;
  page: number;
  frequency: number;
  checked_at: Date;
}

// === FINANCIAL / P&L ===

export interface DBProductCost {
  id: number;
  nm_id: number;
  cost_price: number;
  logistics_cost: number;
  commission_pct: number;
  storage_cost: number;
  packaging_cost: number;
  additional_cost: number;
  created_at: Date;
  updated_at: Date;
}

export interface DBSalesReport {
  id: number;
  nm_id: number;
  date: Date;
  quantity: number;
  revenue: number;
  returns_count: number;
  returns_sum: number;
  wb_commission: number;
  logistics_cost: number;
  storage_cost: number;
  penalties: number;
  additional_charges: number;
  net_payment: number;
  created_at: Date;
}

export interface PnLSummary {
  nm_id: number;
  name: string;
  brand: string;
  total_revenue: number;
  total_wb_commission: number;
  total_logistics: number;
  total_storage: number;
  total_penalties: number;
  total_net_payment: number;
  cost_price: number;
  total_quantity: number;
  total_returns: number;
  estimated_profit: number;
}

export interface UnitEconomics {
  nm_id: number;
  name: string;
  revenue_per_unit: number;
  cost_price: number;
  wb_commission: number;
  logistics: number;
  storage: number;
  packaging: number;
  additional: number;
  total_cost: number;
  profit_per_unit: number;
  margin_pct: number;
  roi_pct: number;
}

// === SMART BIDDER ===

export type BidStrategy = 'target_position' | 'target_cpc' | 'max_bid' | 'drr_target';

export interface DBBidRule {
  id: number;
  campaign_id: number;
  keyword: string | null;
  strategy: BidStrategy;
  target_value: number;
  min_bid: number;
  max_bid: number;
  step: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface DBBidHistory {
  id: number;
  campaign_id: number;
  keyword: string | null;
  old_bid: number;
  new_bid: number;
  reason: string;
  rule_id: number | null;
  created_at: Date;
}

export interface BidRuleInput {
  campaign_id: number;
  keyword?: string;
  strategy: BidStrategy;
  target_value: number;
  min_bid?: number;
  max_bid?: number;
  step?: number;
}

// === ORDERS ===

export interface DBOrder {
  id: number;
  order_id: number;
  nm_id: number;
  srid: string | null;
  date_created: Date;
  date_updated: Date | null;
  warehouse_name: string | null;
  region: string | null;
  price: number;
  converted_price: number;
  discount_percent: number;
  spp: number;
  finished_price: number;
  price_with_disc: number;
  size: string | null;
  brand: string | null;
  subject: string | null;
  category: string | null;
  status: string;
  cancel_dt: Date | null;
  is_cancel: boolean;
  sticker: string | null;
  gn_number: string | null;
  created_at: Date;
}

export interface WBOrder {
  date: string;
  lastChangeDate: string;
  warehouseName: string;
  regionName: string;
  supplierArticle: string;
  nmId: number;
  barcode: string;
  category: string;
  subject: string;
  brand: string;
  techSize: string;
  incomeID: number;
  isSupply: boolean;
  isRealization: boolean;
  totalPrice: number;
  discountPercent: number;
  spp: number;
  finishedPrice: number;
  priceWithDisc: number;
  isCancel: boolean;
  cancelDate: string;
  orderType: string;
  sticker: string;
  gNumber: string;
  srid: string;
}

// === STOCK SNAPSHOTS ===

export interface DBStockSnapshot {
  id: number;
  nm_id: number;
  last_change_date: Date | null;
  supplier_article: string | null;
  tech_size: string | null;
  barcode: string | null;
  quantity: number;
  in_way_to_client: number;
  in_way_from_client: number;
  quantity_full: number;
  warehouse_name: string | null;
  category: string | null;
  subject: string | null;
  brand: string | null;
  sc_code: string | null;
  price: number;
  discount: number;
  snapshot_date: Date;
  created_at: Date;
}

export interface WBStock {
  lastChangeDate: string;
  warehouseName: string;
  supplierArticle: string;
  nmId: number;
  barcode: string;
  techSize: string;
  quantity: number;
  inWayToClient: number;
  inWayFromClient: number;
  quantityFull: number;
  category: string;
  subject: string;
  brand: string;
  SCCode: string;
  Price: number;
  Discount: number;
}

// === TRAFFIC SOURCE ANALYTICS ===

export interface DBTrafficSourceAnalytics {
  id: number;
  nm_id: number;
  date: Date;
  source_name: string;
  open_card_count: number;
  add_to_cart_count: number;
  orders_count: number;
  orders_sum: number;
  buyouts_count: number;
  buyouts_sum: number;
  cancel_count: number;
  cancel_sum: number;
  created_at: Date;
}

// === MARKETING EVENTS ===

export interface DBMarketingEvent {
  id: number;
  nm_id: number;
  event_type: string;
  description: string | null;
  event_date: Date;
  created_by: number | null;
  created_at: Date;
}

export type MarketingEventType =
  | 'price_change'
  | 'photo_update'
  | 'description_update'
  | 'promotion_start'
  | 'promotion_end'
  | 'seo_update'
  | 'new_review_response'
  | 'stock_replenishment'
  | 'other';

// === SCHEDULER ===

export interface SchedulerStatus {
  running: boolean;
  tasks: {
    name: string;
    interval: string;
    lastRun: string | null;
    nextRun: string | null;
    status: 'idle' | 'running' | 'error';
    lastError?: string;
  }[];
}
