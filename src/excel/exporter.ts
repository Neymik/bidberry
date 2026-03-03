import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import type {
  DBCampaign,
  DBCampaignStats,
  DBProduct,
  DBProductAnalytics,
  DailySummary,
  ExcelCampaignRow,
  ExcelProductRow,
} from '../types';

const EXPORTS_DIR = process.env.EXPORTS_DIR || './exports';

// Убедимся, что директория существует
async function ensureExportsDir(): Promise<void> {
  const fs = await import('fs/promises');
  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  } catch {}
}

// === ЭКСПОРТ КАМПАНИЙ ===

export async function exportCampaignsToExcel(
  campaigns: DBCampaign[],
  stats: Map<number, DBCampaignStats[]>
): Promise<string> {
  await ensureExportsDir();

  const rows: ExcelCampaignRow[] = campaigns.map(campaign => {
    const campaignStats = stats.get(campaign.campaign_id) || [];
    const totals = aggregateStats(campaignStats);

    return {
      'ID Кампании': campaign.campaign_id,
      'Название': campaign.name,
      'Тип': campaign.type,
      'Статус': campaign.status,
      'Дневной бюджет': campaign.daily_budget,
      'Показы': totals.views,
      'Клики': totals.clicks,
      'CTR, %': totals.ctr,
      'CPC': totals.cpc,
      'Расход': totals.spend,
      'Заказы': totals.orders,
      'Сумма заказов': totals.orderSum,
      'ROAS': totals.roas,
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Устанавливаем ширину колонок
  ws['!cols'] = [
    { wch: 12 }, // ID
    { wch: 30 }, // Название
    { wch: 15 }, // Тип
    { wch: 15 }, // Статус
    { wch: 15 }, // Бюджет
    { wch: 12 }, // Показы
    { wch: 10 }, // Клики
    { wch: 10 }, // CTR
    { wch: 10 }, // CPC
    { wch: 12 }, // Расход
    { wch: 10 }, // Заказы
    { wch: 15 }, // Сумма заказов
    { wch: 10 }, // ROAS
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Кампании');

  const fileName = `campaigns_${dayjs().format('YYYY-MM-DD_HH-mm-ss')}.xlsx`;
  const filePath = `${EXPORTS_DIR}/${fileName}`;

  XLSX.writeFile(wb, filePath);
  return filePath;
}

// === ЭКСПОРТ СТАТИСТИКИ ПО ДНЯМ ===

export async function exportDailyStatsToExcel(
  stats: DailySummary[]
): Promise<string> {
  await ensureExportsDir();

  const rows = stats.map(day => ({
    'Дата': day.date,
    'Кампаний': day.campaigns_count,
    'Показы': day.total_views,
    'Клики': day.total_clicks,
    'CTR, %': day.avg_ctr,
    'Расход': day.total_spend,
    'Заказы': day.total_orders,
    'Сумма заказов': day.total_order_sum,
    'ROAS': day.roas,
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  ws['!cols'] = [
    { wch: 12 },
    { wch: 10 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 10 },
    { wch: 15 },
    { wch: 10 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Статистика по дням');

  // Добавляем лист с расчётами
  addCalculationsSheet(wb, stats);

  const fileName = `daily_stats_${dayjs().format('YYYY-MM-DD_HH-mm-ss')}.xlsx`;
  const filePath = `${EXPORTS_DIR}/${fileName}`;

  XLSX.writeFile(wb, filePath);
  return filePath;
}

// === ЭКСПОРТ ТОВАРОВ ===

export async function exportProductsToExcel(
  products: DBProduct[],
  analytics: Map<number, DBProductAnalytics[]>
): Promise<string> {
  await ensureExportsDir();

  const rows: ExcelProductRow[] = products.map(product => {
    const productAnalytics = analytics.get(product.nm_id) || [];
    const totals = aggregateProductAnalytics(productAnalytics);

    return {
      'Артикул WB': product.nm_id,
      'Артикул продавца': product.vendor_code,
      'Бренд': product.brand,
      'Категория': product.subject,
      'Название': product.name,
      'Просмотры карточки': totals.openCardCount,
      'В корзину': totals.addToCartCount,
      'Заказы': totals.ordersCount,
      'Сумма заказов': totals.ordersSum,
      'Выкупы': totals.buyoutsCount,
      'Сумма выкупов': totals.buyoutsSum,
      'Отмены': totals.cancelCount,
      'Конверсия в корзину, %': totals.conversionToCart,
      'Конверсия в заказ, %': totals.conversionToOrder,
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  ws['!cols'] = [
    { wch: 12 },
    { wch: 15 },
    { wch: 15 },
    { wch: 20 },
    { wch: 40 },
    { wch: 15 },
    { wch: 12 },
    { wch: 10 },
    { wch: 15 },
    { wch: 10 },
    { wch: 15 },
    { wch: 10 },
    { wch: 18 },
    { wch: 18 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Товары');

  const fileName = `products_${dayjs().format('YYYY-MM-DD_HH-mm-ss')}.xlsx`;
  const filePath = `${EXPORTS_DIR}/${fileName}`;

  XLSX.writeFile(wb, filePath);
  return filePath;
}

// === ЭКСПОРТ СТАВОК ===

export async function exportBidsToExcel(
  campaignId: number,
  bids: { keyword: string; bid: number; position: number; cpm: number }[]
): Promise<string> {
  await ensureExportsDir();

  const rows = bids.map(bid => ({
    'Ключевое слово': bid.keyword,
    'Ставка': bid.bid,
    'Позиция': bid.position,
    'CPM': bid.cpm,
    'Рекомендуемая ставка': Math.round(bid.cpm * 1.1), // +10%
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  ws['!cols'] = [
    { wch: 40 },
    { wch: 12 },
    { wch: 10 },
    { wch: 12 },
    { wch: 18 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, `Ставки кампании ${campaignId}`);

  const fileName = `bids_${campaignId}_${dayjs().format('YYYY-MM-DD_HH-mm-ss')}.xlsx`;
  const filePath = `${EXPORTS_DIR}/${fileName}`;

  XLSX.writeFile(wb, filePath);
  return filePath;
}

// === ПОЛНЫЙ ОТЧЁТ ===

export async function exportFullReport(
  campaigns: DBCampaign[],
  campaignStats: Map<number, DBCampaignStats[]>,
  dailySummary: DailySummary[],
  products: DBProduct[],
  productAnalytics: Map<number, DBProductAnalytics[]>
): Promise<string> {
  await ensureExportsDir();

  const wb = XLSX.utils.book_new();

  // Лист 1: Сводка
  const summaryData = calculateSummary(dailySummary);
  const summaryWs = XLSX.utils.json_to_sheet([summaryData]);
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Сводка');

  // Лист 2: Кампании
  const campaignRows = campaigns.map(campaign => {
    const stats = campaignStats.get(campaign.campaign_id) || [];
    const totals = aggregateStats(stats);
    return {
      'ID': campaign.campaign_id,
      'Название': campaign.name,
      'Тип': campaign.type,
      'Статус': campaign.status,
      'Показы': totals.views,
      'Клики': totals.clicks,
      'CTR': totals.ctr,
      'Расход': totals.spend,
      'Заказы': totals.orders,
      'Выручка': totals.orderSum,
      'ROAS': totals.roas,
    };
  });
  const campaignsWs = XLSX.utils.json_to_sheet(campaignRows);
  XLSX.utils.book_append_sheet(wb, campaignsWs, 'Кампании');

  // Лист 3: Статистика по дням
  const dailyWs = XLSX.utils.json_to_sheet(dailySummary.map(d => ({
    'Дата': d.date,
    'Показы': d.total_views,
    'Клики': d.total_clicks,
    'CTR': d.avg_ctr,
    'Расход': d.total_spend,
    'Заказы': d.total_orders,
    'Выручка': d.total_order_sum,
    'ROAS': d.roas,
  })));
  XLSX.utils.book_append_sheet(wb, dailyWs, 'По дням');

  // Лист 4: Товары
  const productRows = products.map(product => {
    const analytics = productAnalytics.get(product.nm_id) || [];
    const totals = aggregateProductAnalytics(analytics);
    return {
      'Артикул': product.nm_id,
      'Название': product.name,
      'Бренд': product.brand,
      'Просмотры': totals.openCardCount,
      'В корзину': totals.addToCartCount,
      'Заказы': totals.ordersCount,
      'Выручка': totals.ordersSum,
      'Конв. корзина': totals.conversionToCart,
      'Конв. заказ': totals.conversionToOrder,
    };
  });
  const productsWs = XLSX.utils.json_to_sheet(productRows);
  XLSX.utils.book_append_sheet(wb, productsWs, 'Товары');

  // Лист 5: Расчёты и формулы
  addCalculationsSheet(wb, dailySummary);

  const fileName = `full_report_${dayjs().format('YYYY-MM-DD_HH-mm-ss')}.xlsx`;
  const filePath = `${EXPORTS_DIR}/${fileName}`;

  XLSX.writeFile(wb, filePath);
  return filePath;
}

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

function aggregateStats(stats: DBCampaignStats[]): {
  views: number;
  clicks: number;
  ctr: number;
  cpc: number;
  spend: number;
  orders: number;
  orderSum: number;
  roas: number;
} {
  const totals = stats.reduce(
    (acc, s) => ({
      views: acc.views + Number(s.views || 0),
      clicks: acc.clicks + Number(s.clicks || 0),
      spend: acc.spend + Number(s.spend || 0),
      orders: acc.orders + Number(s.orders || 0),
      orderSum: acc.orderSum + Number(s.order_sum || 0),
    }),
    { views: 0, clicks: 0, spend: 0, orders: 0, orderSum: 0 }
  );

  return {
    ...totals,
    ctr: totals.views > 0 ? (totals.clicks / totals.views) * 100 : 0,
    cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
    roas: totals.spend > 0 ? totals.orderSum / totals.spend : 0,
  };
}

function aggregateProductAnalytics(analytics: DBProductAnalytics[]): {
  openCardCount: number;
  addToCartCount: number;
  ordersCount: number;
  ordersSum: number;
  buyoutsCount: number;
  buyoutsSum: number;
  cancelCount: number;
  conversionToCart: number;
  conversionToOrder: number;
} {
  const totals = analytics.reduce(
    (acc, a) => ({
      openCardCount: acc.openCardCount + Number(a.open_card_count || 0),
      addToCartCount: acc.addToCartCount + Number(a.add_to_cart_count || 0),
      ordersCount: acc.ordersCount + Number(a.orders_count || 0),
      ordersSum: acc.ordersSum + Number(a.orders_sum || 0),
      buyoutsCount: acc.buyoutsCount + Number(a.buyouts_count || 0),
      buyoutsSum: acc.buyoutsSum + Number(a.buyouts_sum || 0),
      cancelCount: acc.cancelCount + Number(a.cancel_count || 0),
    }),
    {
      openCardCount: 0,
      addToCartCount: 0,
      ordersCount: 0,
      ordersSum: 0,
      buyoutsCount: 0,
      buyoutsSum: 0,
      cancelCount: 0,
    }
  );

  return {
    ...totals,
    conversionToCart: totals.openCardCount > 0
      ? (totals.addToCartCount / totals.openCardCount) * 100
      : 0,
    conversionToOrder: totals.addToCartCount > 0
      ? (totals.ordersCount / totals.addToCartCount) * 100
      : 0,
  };
}

function calculateSummary(dailySummary: DailySummary[]): Record<string, any> {
  const totalViews = dailySummary.reduce((sum, d) => sum + Number(d.total_views), 0);
  const totalClicks = dailySummary.reduce((sum, d) => sum + Number(d.total_clicks), 0);
  const totalSpend = dailySummary.reduce((sum, d) => sum + Number(d.total_spend), 0);
  const totalOrders = dailySummary.reduce((sum, d) => sum + Number(d.total_orders), 0);
  const totalRevenue = dailySummary.reduce((sum, d) => sum + Number(d.total_order_sum), 0);

  return {
    'Период': `${dailySummary[dailySummary.length - 1]?.date || ''} - ${dailySummary[0]?.date || ''}`,
    'Всего дней': dailySummary.length,
    'Всего показов': totalViews,
    'Всего кликов': totalClicks,
    'Средний CTR, %': totalViews > 0 ? ((totalClicks / totalViews) * 100).toFixed(2) : 0,
    'Общий расход': totalSpend.toFixed(2),
    'Средний расход/день': dailySummary.length > 0 ? (totalSpend / dailySummary.length).toFixed(2) : 0,
    'Всего заказов': totalOrders,
    'Общая выручка': totalRevenue.toFixed(2),
    'ROAS': totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : 0,
    'CPO (стоимость заказа)': totalOrders > 0 ? (totalSpend / totalOrders).toFixed(2) : 0,
    'ДРР, %': totalRevenue > 0 ? ((totalSpend / totalRevenue) * 100).toFixed(2) : 0,
  };
}

function addCalculationsSheet(wb: XLSX.WorkBook, dailySummary: DailySummary[]): void {
  const totalSpend = dailySummary.reduce((sum, d) => sum + Number(d.total_spend), 0);
  const totalOrders = dailySummary.reduce((sum, d) => sum + Number(d.total_orders), 0);
  const totalRevenue = dailySummary.reduce((sum, d) => sum + Number(d.total_order_sum), 0);
  const totalViews = dailySummary.reduce((sum, d) => sum + Number(d.total_views), 0);
  const totalClicks = dailySummary.reduce((sum, d) => sum + Number(d.total_clicks), 0);

  const calculations = [
    { 'Метрика': 'ROAS (Return on Ad Spend)', 'Формула': 'Выручка / Расход', 'Значение': totalSpend > 0 ? (totalRevenue / totalSpend).toFixed(2) : 'N/A' },
    { 'Метрика': 'ДРР (Доля рекламных расходов)', 'Формула': '(Расход / Выручка) * 100%', 'Значение': totalRevenue > 0 ? ((totalSpend / totalRevenue) * 100).toFixed(2) + '%' : 'N/A' },
    { 'Метрика': 'CPO (Cost Per Order)', 'Формула': 'Расход / Заказы', 'Значение': totalOrders > 0 ? (totalSpend / totalOrders).toFixed(2) : 'N/A' },
    { 'Метрика': 'CPC (Cost Per Click)', 'Формула': 'Расход / Клики', 'Значение': totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : 'N/A' },
    { 'Метрика': 'CTR (Click Through Rate)', 'Формула': '(Клики / Показы) * 100%', 'Значение': totalViews > 0 ? ((totalClicks / totalViews) * 100).toFixed(2) + '%' : 'N/A' },
    { 'Метрика': 'CR (Conversion Rate)', 'Формула': '(Заказы / Клики) * 100%', 'Значение': totalClicks > 0 ? ((totalOrders / totalClicks) * 100).toFixed(2) + '%' : 'N/A' },
    { 'Метрика': 'Средний чек', 'Формула': 'Выручка / Заказы', 'Значение': totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : 'N/A' },
    { 'Метрика': 'CPM (Cost Per Mille)', 'Формула': '(Расход / Показы) * 1000', 'Значение': totalViews > 0 ? ((totalSpend / totalViews) * 1000).toFixed(2) : 'N/A' },
  ];

  const calcWs = XLSX.utils.json_to_sheet(calculations);
  calcWs['!cols'] = [{ wch: 30 }, { wch: 30 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, calcWs, 'Расчёты');
}

export function getExportsDir(): string {
  return EXPORTS_DIR;
}
