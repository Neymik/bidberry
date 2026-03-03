import { test, expect, mock, describe, beforeAll, afterAll } from 'bun:test';
import * as XLSX from 'xlsx';
import { unlink } from 'fs/promises';
import type {
  DBProduct,
  DBProductAnalytics,
  DBOrder,
  DBStockSnapshot,
  DBCampaign,
  DBCampaignStats,
  DBTrafficSourceAnalytics,
  DBMarketingEvent,
  DBKeywordCollection,
  DBKeywordPosition,
} from '../types';

// ============================================================
// MOCK DATA FIXTURES
// ============================================================

const MOCK_PRODUCTS: DBProduct[] = [
  {
    id: 1, nm_id: 100001, vendor_code: 'ART-001', brand: 'TestBrand',
    subject: 'Футболка', name: 'Тестовая футболка', price: 1500,
    discount: 10, final_price: 1350, rating: 4.5, feedbacks: 120,
    created_at: new Date('2025-01-01'), updated_at: new Date('2025-06-01'),
  },
  {
    id: 2, nm_id: 100002, vendor_code: 'ART-002', brand: 'TestBrand',
    subject: 'Джинсы', name: 'Тестовые джинсы', price: 3000,
    discount: 15, final_price: 2550, rating: 4.2, feedbacks: 80,
    created_at: new Date('2025-02-01'), updated_at: new Date('2025-06-01'),
  },
];

const MOCK_ANALYTICS: DBProductAnalytics[] = [
  {
    id: 1, nm_id: 100001, date: new Date('2025-06-01'),
    open_card_count: 500, add_to_cart_count: 100, orders_count: 50,
    orders_sum: 67500, buyouts_count: 40, buyouts_sum: 54000,
    cancel_count: 5, cancel_sum: 6750, conversion_to_cart: 20,
    conversion_to_order: 50, created_at: new Date(),
  },
  {
    id: 2, nm_id: 100001, date: new Date('2025-06-02'),
    open_card_count: 600, add_to_cart_count: 120, orders_count: 60,
    orders_sum: 81000, buyouts_count: 50, buyouts_sum: 67500,
    cancel_count: 3, cancel_sum: 4050, conversion_to_cart: 20,
    conversion_to_order: 50, created_at: new Date(),
  },
];

const MOCK_ORDERS: DBOrder[] = [
  {
    id: 1, order_id: 90001, nm_id: 100001, srid: 'srid001',
    date_created: new Date('2025-06-01 10:00:00'),
    date_updated: new Date('2025-06-03 12:00:00'),
    warehouse_name: 'Коледино', region: 'Москва', price: 1500,
    converted_price: 1500, discount_percent: 10, spp: 5,
    finished_price: 1200, price_with_disc: 1350, size: 'M',
    brand: 'TestBrand', subject: 'Футболка', category: 'Одежда',
    status: 'delivered', cancel_dt: null, is_cancel: false,
    sticker: null, gn_number: null, created_at: new Date(),
  },
  {
    id: 2, order_id: 90002, nm_id: 100002, srid: 'srid002',
    date_created: new Date('2025-06-02 14:00:00'),
    date_updated: null,
    warehouse_name: 'Подольск', region: 'Санкт-Петербург', price: 3000,
    converted_price: 3000, discount_percent: 15, spp: 7,
    finished_price: 2300, price_with_disc: 2550, size: 'L',
    brand: 'TestBrand', subject: 'Джинсы', category: 'Одежда',
    status: 'cancelled', cancel_dt: new Date('2025-06-03'), is_cancel: true,
    sticker: null, gn_number: null, created_at: new Date(),
  },
];

const MOCK_STOCKS: DBStockSnapshot[] = [
  {
    id: 1, nm_id: 100001, last_change_date: new Date('2025-06-01'),
    supplier_article: 'ART-001', tech_size: 'M', barcode: '2000000000001',
    quantity: 50, in_way_to_client: 5, in_way_from_client: 2,
    quantity_full: 57, warehouse_name: 'Коледино', category: 'Одежда',
    subject: 'Футболка', brand: 'TestBrand', sc_code: 'SC01',
    price: 1500, discount: 10, snapshot_date: new Date('2025-06-01'),
    created_at: new Date(),
  },
];

const MOCK_STOCKS_SUMMARY = [
  {
    nm_id: 100001, supplier_article: 'ART-001', brand: 'TestBrand',
    subject: 'Футболка', total_quantity: 150, total_in_way_to_client: 10,
    total_in_way_from_client: 5, total_quantity_full: 165,
    warehouses_count: 3, sizes_count: 4,
  },
  {
    nm_id: 100002, supplier_article: 'ART-002', brand: 'TestBrand',
    subject: 'Джинсы', total_quantity: 80, total_in_way_to_client: 3,
    total_in_way_from_client: 1, total_quantity_full: 84,
    warehouses_count: 2, sizes_count: 3,
  },
];

const MOCK_TRAFFIC_SOURCES: DBTrafficSourceAnalytics[] = [
  {
    id: 1, nm_id: 100001, date: new Date('2025-06-01'),
    source_name: 'Поиск', open_card_count: 300, add_to_cart_count: 60,
    orders_count: 30, orders_sum: 40500, buyouts_count: 25,
    buyouts_sum: 33750, cancel_count: 2, cancel_sum: 2700,
    created_at: new Date(),
  },
];

const MOCK_TRAFFIC_SUMMARY = [
  {
    source_name: 'Поиск', total_views: 800, total_cart: 160,
    total_orders: 80, total_orders_sum: 108000, total_buyouts: 65,
    total_cancels: 5, conversion_to_cart: 20, conversion_to_order: 50,
  },
];

const MOCK_EVENTS: DBMarketingEvent[] = [
  {
    id: 1, nm_id: 100001, event_type: 'price_change',
    description: 'Снижение цены на 10%', event_date: new Date('2025-06-01'),
    created_by: null, created_at: new Date('2025-06-01 09:00:00'),
  },
  {
    id: 2, nm_id: 100002, event_type: 'promotion_start',
    description: 'Летняя распродажа', event_date: new Date('2025-06-02'),
    created_by: 1, created_at: new Date('2025-06-02 10:00:00'),
  },
];

const MOCK_CAMPAIGNS: DBCampaign[] = [
  {
    id: 1, campaign_id: 5001, name: 'Летняя кампания', type: 'Поиск',
    status: 'Активна', start_date: new Date('2025-06-01'),
    end_date: new Date('2025-06-30'), daily_budget: 5000,
    created_at: new Date(), updated_at: new Date(),
  },
];

const MOCK_CAMPAIGN_STATS: DBCampaignStats[] = [
  {
    id: 1, campaign_id: 5001, date: new Date('2025-06-01'),
    views: 10000, clicks: 300, ctr: 3.0, cpc: 16.67, cpm: 500,
    spend: 5000, orders: 15, order_sum: 22500, atbs: 200,
    shks: 150, sum_price: 30000, created_at: new Date(),
  },
];

const MOCK_KEYWORDS: DBKeywordCollection[] = [
  {
    id: 1, nm_id: 100001, keyword: 'футболка мужская',
    frequency: 15000, is_tracked: true, source: 'wb_search',
    created_at: new Date(), updated_at: new Date(),
  },
  {
    id: 2, nm_id: 100001, keyword: 'футболка хлопок',
    frequency: 8000, is_tracked: true, source: 'manual',
    created_at: new Date(), updated_at: new Date(),
  },
];

const MOCK_KEYWORD_POSITIONS: DBKeywordPosition[] = [
  {
    id: 1, nm_id: 100001, keyword: 'футболка мужская',
    position: 5, page: 1, frequency: 15000,
    checked_at: new Date('2025-06-01 08:00:00'),
  },
];

const MOCK_SEARCH_QUERY_SUMMARY = [
  {
    nm_id: 100001, keyword: 'футболка мужская',
    avg_position: 3.5, total_impressions: 5000, total_visits: 800,
    total_cart_adds: 150, total_orders: 60, avg_ctr: 16.0, avg_visibility: 45.2,
  },
  {
    nm_id: 100001, keyword: 'футболка хлопок',
    avg_position: 8.2, total_impressions: 2000, total_visits: 300,
    total_cart_adds: 50, total_orders: 20, avg_ctr: 15.0, avg_visibility: 22.1,
  },
];

// ============================================================
// MUTABLE MOCK DATA (can be swapped for empty-data tests)
// ============================================================

const ORIGINAL_MOCK_DATA = {
  products: MOCK_PRODUCTS,
  analytics: MOCK_ANALYTICS,
  orders: MOCK_ORDERS,
  stocks: MOCK_STOCKS,
  stocksSummary: MOCK_STOCKS_SUMMARY,
  trafficSources: MOCK_TRAFFIC_SOURCES,
  trafficSummary: MOCK_TRAFFIC_SUMMARY,
  events: MOCK_EVENTS,
  campaigns: MOCK_CAMPAIGNS,
  campaignStats: MOCK_CAMPAIGN_STATS,
  keywords: MOCK_KEYWORDS,
  keywordPositions: MOCK_KEYWORD_POSITIONS,
  searchQuerySummary: MOCK_SEARCH_QUERY_SUMMARY,
};

let mockData = { ...ORIGINAL_MOCK_DATA };

// ============================================================
// MODULE MOCKS (must be before import of report-generator)
// ============================================================

mock.module('../db/connection', () => ({
  query: mock(async () => []),
  execute: mock(async () => ({})),
  getPool: mock(async () => ({})),
  getConnection: mock(async () => ({})),
  closePool: mock(async () => {}),
  checkConnection: mock(async () => true),
  transaction: mock(async (cb: any) => cb({})),
  getDBConfig: mock(() => ({})),
}));

mock.module('../db/repository', () => ({
  getProducts: mock(async () => mockData.products),
  getProductById: mock(async (nmId: number) =>
    mockData.products.find(p => p.nm_id === nmId) ?? null
  ),
  getProductAnalytics: mock(async (nmId: number) =>
    mockData.analytics.filter(a => a.nm_id === nmId)
  ),
  getCampaigns: mock(async () => mockData.campaigns),
  getCampaignStats: mock(async (campaignId: number) =>
    mockData.campaignStats.filter(s => s.campaign_id === campaignId)
  ),
}));

mock.module('../db/orders-repository', () => ({
  getOrders: mock(async (_dateFrom?: string, _dateTo?: string, nmId?: number) => {
    if (nmId) return mockData.orders.filter(o => o.nm_id === nmId);
    return mockData.orders;
  }),
}));

mock.module('../db/stock-repository', () => ({
  getStocksByNmId: mock(async (nmId: number) =>
    mockData.stocks.filter(s => s.nm_id === nmId)
  ),
  getStocksSummary: mock(async () => mockData.stocksSummary),
}));

mock.module('../db/traffic-repository', () => ({
  getTrafficSourcesByNmId: mock(async (nmId: number) =>
    mockData.trafficSources.filter(s => s.nm_id === nmId)
  ),
  getTrafficSourcesSummary: mock(async () => mockData.trafficSummary),
}));

mock.module('../db/events-repository', () => ({
  getEventsByNmId: mock(async (nmId: number) =>
    mockData.events.filter(e => e.nm_id === nmId)
  ),
  getAllEvents: mock(async () => mockData.events),
}));

mock.module('../db/search-repository', () => ({
  getSearchQuerySummary: mock(async (nmId: number) =>
    mockData.searchQuerySummary.filter(s => s.nm_id === nmId)
  ),
  getAllSearchQuerySummary: mock(async () => mockData.searchQuerySummary),
}));

mock.module('../db/keywords-repository', () => ({
  getKeywords: mock(async (nmId: number) =>
    mockData.keywords.filter(k => k.nm_id === nmId)
  ),
  getAllTrackedKeywords: mock(async () =>
    mockData.keywords.filter(k => k.is_tracked)
  ),
  getKeywordPositions: mock(async (nmId: number, keyword: string) =>
    mockData.keywordPositions.filter(p => p.nm_id === nmId && p.keyword === keyword)
  ),
}));

// ============================================================
// IMPORT GENERATOR (after mocks are set up)
// ============================================================

const { generatePerechenReport } = await import('./report-generator');

// ============================================================
// HELPERS
// ============================================================

const EXPECTED_SHEET_NAMES = [
  'Воронка',
  'Лента заказов',
  'Остатки',
  'Точки входа',
  'Маркетинг',
  'Рекламные компании',
  'Кластеры',
];

function getSheetRows(wb: XLSX.WorkBook, sheetName: string): any[][] {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);
  return XLSX.utils.sheet_to_json(ws, { header: 1 });
}

function getSheetData(wb: XLSX.WorkBook, sheetName: string): any[] {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);
  return XLSX.utils.sheet_to_json(ws);
}

const generatedFiles: string[] = [];

// ============================================================
// TEST GROUP 1: All-products report (no nmId)
// ============================================================

describe('all-products report', () => {
  let filePath: string;
  let workbook: XLSX.WorkBook;

  beforeAll(async () => {
    mockData = { ...ORIGINAL_MOCK_DATA };
    filePath = await generatePerechenReport('2025-06-01', '2025-06-30');
    generatedFiles.push(filePath);
    workbook = XLSX.readFile(filePath);
  });

  test('returns a valid xlsx file path', () => {
    expect(filePath).toContain('perechen_all_');
    expect(filePath).toEndWith('.xlsx');
  });

  test('workbook contains all 7 sheets', () => {
    expect(workbook.SheetNames).toEqual(EXPECTED_SHEET_NAMES);
  });

  test('Воронка has correct headers and data', () => {
    const rows = getSheetRows(workbook, 'Воронка');
    const headers = rows[0];
    expect(headers).toContain('Артикул');
    expect(headers).toContain('Артикул продавца');
    expect(headers).toContain('Показы (карточка)');
    expect(headers).toContain('% Выкупа');
    expect(headers).toContain('Цена');
    // 2 analytics entries for product 100001 = 2 data rows + header
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  test('Лента заказов has correct headers and row count', () => {
    const rows = getSheetRows(workbook, 'Лента заказов');
    const headers = rows[0];
    expect(headers).toContain('ID заказа');
    expect(headers).toContain('Статус');
    expect(headers).toContain('Отменён');
    expect(headers).toContain('Дней доставки');
    expect(rows.length).toBe(3); // header + 2 orders
  });

  test('Остатки uses summary view', () => {
    const rows = getSheetRows(workbook, 'Остатки');
    const headers = rows[0];
    expect(headers).toContain('На складе (всего)');
    expect(headers).toContain('Складов');
    expect(headers).toContain('Размеров');
    expect(rows.length).toBe(3); // header + 2 summary rows
  });

  test('Точки входа has traffic data with source', () => {
    const rows = getSheetRows(workbook, 'Точки входа');
    const headers = rows[0];
    expect(headers).toContain('Артикул');
    expect(headers).toContain('Источник');
    expect(headers).toContain('Конверсия в корзину, %');
  });

  test('Маркетинг translates event types to Russian', () => {
    const data = getSheetData(workbook, 'Маркетинг');
    const types = data.map((r: any) => r['Тип события']);
    expect(types).toContain('Изменение цены');
    expect(types).toContain('Начало акции');
    expect(data.length).toBe(2);
  });

  test('Рекламные компании has campaign data', () => {
    const rows = getSheetRows(workbook, 'Рекламные компании');
    const headers = rows[0];
    expect(headers).toContain('ID');
    expect(headers).toContain('Название');
    expect(headers).toContain('ROAS');
    expect(headers).toContain('CPM');
    expect(rows.length).toBe(2); // header + 1 campaign day
  });

  test('Кластеры has keyword data', () => {
    const rows = getSheetRows(workbook, 'Кластеры');
    const headers = rows[0];
    expect(headers).toContain('Артикул');
    expect(headers).toContain('Ключевой запрос');
    expect(headers).toContain('Ср. позиция');
    expect(headers).toContain('Показы');
    expect(headers).toContain('CTR, %');
    expect(headers).toContain('Видимость, %');
    expect(rows.length).toBe(3); // header + 2 search queries
  });
});

// ============================================================
// TEST GROUP 2: Single-product report (nmId = 100001)
// ============================================================

describe('single-product report', () => {
  let filePath: string;
  let workbook: XLSX.WorkBook;

  beforeAll(async () => {
    mockData = { ...ORIGINAL_MOCK_DATA };
    filePath = await generatePerechenReport('2025-06-01', '2025-06-30', 100001);
    generatedFiles.push(filePath);
    workbook = XLSX.readFile(filePath);
  });

  test('file name contains the nmId', () => {
    expect(filePath).toContain('_100001_');
  });

  test('all 7 sheets present', () => {
    expect(workbook.SheetNames).toEqual(EXPECTED_SHEET_NAMES);
  });

  test('Воронка only shows data for nmId 100001', () => {
    const data = getSheetData(workbook, 'Воронка');
    for (const row of data) {
      expect((row as any)['Артикул']).toBe(100001);
    }
  });

  test('Остатки uses detailed view (not summary)', () => {
    const rows = getSheetRows(workbook, 'Остатки');
    const headers = rows[0];
    expect(headers).toContain('На складе');
    expect(headers).toContain('Баркод');
    expect(headers).toContain('Склад');
    expect(headers).not.toContain('На складе (всего)');
  });

  test('Точки входа uses per-date view (no Название column)', () => {
    const rows = getSheetRows(workbook, 'Точки входа');
    const headers = rows[0];
    expect(headers).toContain('Дата');
    expect(headers).not.toContain('Название');
  });
});

// ============================================================
// TEST GROUP 3: Empty data
// ============================================================

describe('empty data', () => {
  let filePath: string;
  let workbook: XLSX.WorkBook;

  beforeAll(async () => {
    // Override all mock data with empty arrays
    mockData = {
      products: [],
      analytics: [],
      orders: [],
      stocks: [],
      stocksSummary: [],
      trafficSources: [],
      trafficSummary: [],
      events: [],
      campaigns: [],
      campaignStats: [],
      keywords: [],
      keywordPositions: [],
      searchQuerySummary: [],
    };

    filePath = await generatePerechenReport('2025-06-01', '2025-06-30');
    generatedFiles.push(filePath);
    workbook = XLSX.readFile(filePath);
  });

  afterAll(() => {
    mockData = { ...ORIGINAL_MOCK_DATA };
  });

  test('report generates without crash with all 7 sheets', () => {
    expect(filePath).toBeTruthy();
    expect(workbook.SheetNames).toEqual(EXPECTED_SHEET_NAMES);
  });

  test('each sheet has placeholder text', () => {
    // Воронка
    const funnel = getSheetData(workbook, 'Воронка');
    expect(funnel.length).toBe(1);
    expect((funnel[0] as any)['Артикул']).toBe('Нет данных');

    // Лента заказов
    const orders = getSheetData(workbook, 'Лента заказов');
    expect(orders.length).toBe(1);

    // Остатки
    const stocks = getSheetData(workbook, 'Остатки');
    expect(stocks.length).toBe(1);

    // Рекламные компании
    const campaigns = getSheetData(workbook, 'Рекламные компании');
    expect(campaigns.length).toBe(1);

    // Кластеры
    const keywords = getSheetData(workbook, 'Кластеры');
    expect(keywords.length).toBe(1);
  });
});

// ============================================================
// TEST GROUP 4: Calculated fields
// ============================================================

describe('calculated fields', () => {
  let workbook: XLSX.WorkBook;

  beforeAll(async () => {
    mockData = { ...ORIGINAL_MOCK_DATA };
    const filePath = await generatePerechenReport('2025-06-01', '2025-06-30');
    generatedFiles.push(filePath);
    workbook = XLSX.readFile(filePath);
  });

  test('Воронка % Выкупа = round((buyouts/orders)*100)', () => {
    const data = getSheetData(workbook, 'Воронка');
    const row = data[0] as any;
    // buyouts_count=40, orders_count=50 => 80%
    expect(row['% Выкупа']).toBe(80);
  });

  test('Лента заказов Отменён shows Да/Нет correctly', () => {
    const data = getSheetData(workbook, 'Лента заказов');
    const delivered = data.find((r: any) => r['Статус'] === 'delivered') as any;
    const cancelled = data.find((r: any) => r['Статус'] === 'cancelled') as any;
    expect(delivered?.['Отменён']).toBe('Нет');
    expect(cancelled?.['Отменён']).toBe('Да');
  });

  test('Рекламные компании ROAS = round(order_sum / spend)', () => {
    const data = getSheetData(workbook, 'Рекламные компании');
    const row = data[0] as any;
    // 22500 / 5000 = 4.5
    expect(row['ROAS']).toBe(4.5);
  });

  test('Кластеры shows search analytics data with impressions', () => {
    const data = getSheetData(workbook, 'Кластеры');
    for (const row of data) {
      expect((row as any)['Показы']).toBeGreaterThan(0);
      expect((row as any)['Ключевой запрос']).toBeTruthy();
    }
  });
});

// ============================================================
// CLEANUP
// ============================================================

afterAll(async () => {
  for (const fp of generatedFiles) {
    try {
      await unlink(fp);
    } catch {}
  }
});
