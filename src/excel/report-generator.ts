import * as XLSX from 'xlsx';
import dayjs from 'dayjs';
import * as repo from '../db/repository';
import * as ordersRepo from '../db/orders-repository';
import * as stockRepo from '../db/stock-repository';
import * as trafficRepo from '../db/traffic-repository';
import * as eventsRepo from '../db/events-repository';
import * as keywordsRepo from '../db/keywords-repository';
import * as searchRepo from '../db/search-repository';

const EXPORTS_DIR = process.env.EXPORTS_DIR || './exports';

export type SectionType = 'voronka' | 'orders' | 'stocks' | 'traffic' | 'marketing' | 'campaigns' | 'clusters';

const VALID_SECTIONS: SectionType[] = ['voronka', 'orders', 'stocks', 'traffic', 'marketing', 'campaigns', 'clusters'];

async function ensureExportsDir(): Promise<void> {
  const fs = await import('fs/promises');
  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  } catch {}
}

/**
 * Generate full "Перечень информации" report matching the template structure.
 * Can generate for a specific product (nmId) or all products (nmId = undefined).
 */
export async function generatePerechenReport(
  dateFrom: string,
  dateTo: string,
  nmId?: number
): Promise<string> {
  await ensureExportsDir();

  const wb = XLSX.utils.book_new();

  // Sheet 1: Воронка (Product Funnel)
  await addFunnelSheet(wb, dateFrom, dateTo, nmId);

  // Sheet 2: Лента заказов (Orders Feed)
  await addOrdersSheet(wb, dateFrom, dateTo, nmId);

  // Sheet 3: Остатки (Stock/Inventory)
  await addStocksSheet(wb, nmId);

  // Sheet 4: Воронка по точкам входа (Traffic Sources)
  await addTrafficSourcesSheet(wb, dateFrom, dateTo, nmId);

  // Sheet 5: Маркетинговая активность (Marketing Events)
  await addMarketingEventsSheet(wb, dateFrom, dateTo, nmId);

  // Sheet 6: Рекламные компании (Ad Campaigns)
  await addCampaignsSheet(wb, dateFrom, dateTo);

  // Sheet 7: Кластеры (Keywords/Clusters + Search Analytics)
  await addKeywordsSheet(wb, dateFrom, dateTo, nmId);

  const suffix = nmId ? `_${nmId}` : '_all';
  const fileName = `perechen${suffix}_${dayjs().format('YYYY-MM-DD_HH-mm-ss')}.xlsx`;
  const filePath = `${EXPORTS_DIR}/${fileName}`;

  XLSX.writeFile(wb, filePath);
  return filePath;
}

/**
 * Generate a single-section report from the Перечень template.
 */
export async function generateSectionReport(
  section: SectionType,
  dateFrom: string,
  dateTo: string,
  nmId?: number
): Promise<string> {
  if (!VALID_SECTIONS.includes(section)) {
    throw new Error(`Invalid section: ${section}. Valid: ${VALID_SECTIONS.join(', ')}`);
  }

  await ensureExportsDir();
  const wb = XLSX.utils.book_new();

  const sectionMap: Record<SectionType, () => Promise<void>> = {
    voronka: () => addFunnelSheet(wb, dateFrom, dateTo, nmId),
    orders: () => addOrdersSheet(wb, dateFrom, dateTo, nmId),
    stocks: () => addStocksSheet(wb, nmId),
    traffic: () => addTrafficSourcesSheet(wb, dateFrom, dateTo, nmId),
    marketing: () => addMarketingEventsSheet(wb, dateFrom, dateTo, nmId),
    campaigns: () => addCampaignsSheet(wb, dateFrom, dateTo),
    clusters: () => addKeywordsSheet(wb, dateFrom, dateTo, nmId),
  };

  await sectionMap[section]();

  const suffix = nmId ? `_${nmId}` : '';
  const fileName = `section_${section}${suffix}_${dayjs().format('YYYY-MM-DD_HH-mm-ss')}.xlsx`;
  const filePath = `${EXPORTS_DIR}/${fileName}`;

  XLSX.writeFile(wb, filePath);
  return filePath;
}

// === Sheet 1: Воронка ===
async function addFunnelSheet(
  wb: XLSX.WorkBook,
  dateFrom: string,
  dateTo: string,
  nmId?: number
): Promise<void> {
  const products = nmId
    ? [await repo.getProductById(nmId)].filter(Boolean) as any[]
    : await repo.getProducts();

  const rows: any[] = [];

  for (const product of products) {
    const analytics = await repo.getProductAnalytics(product.nm_id, dateFrom, dateTo);

    for (const day of analytics) {
      const buyoutPct = day.orders_count > 0
        ? (day.buyouts_count / day.orders_count) * 100
        : 0;

      rows.push({
        'Артикул': product.nm_id,
        'Артикул продавца': product.vendor_code || '',
        'Название': product.name || '',
        'Дата': dayjs(day.date).format('YYYY-MM-DD'),
        'Показы (карточка)': day.open_card_count,
        'Положили в корзину': day.add_to_cart_count,
        'Конверсия в корзину, %': day.conversion_to_cart,
        'Заказали': day.orders_count,
        'Конверсия в заказ, %': day.conversion_to_order,
        'Сумма заказов': day.orders_sum,
        'Выкупили': day.buyouts_count,
        'Сумма выкупов': day.buyouts_sum,
        'Отменили': day.cancel_count,
        'Сумма отмен': day.cancel_sum,
        '% Выкупа': Math.round(buyoutPct * 100) / 100,
        'Цена': product.final_price || 0,
      });
    }
  }

  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'Артикул': 'Нет данных' }]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 15 }, { wch: 30 }, { wch: 12 },
    { wch: 15 }, { wch: 18 }, { wch: 20 }, { wch: 10 },
    { wch: 20 }, { wch: 15 }, { wch: 10 }, { wch: 15 },
    { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Воронка');
}

// === Sheet 2: Лента заказов ===
async function addOrdersSheet(
  wb: XLSX.WorkBook,
  dateFrom: string,
  dateTo: string,
  nmId?: number
): Promise<void> {
  const orders = await ordersRepo.getOrders(dateFrom, dateTo, nmId, 5000);

  const rows = orders.map(o => ({
    'ID заказа': o.order_id,
    'Артикул': o.nm_id,
    'Дата создания': dayjs(o.date_created).format('YYYY-MM-DD HH:mm'),
    'Дата обновления': o.date_updated ? dayjs(o.date_updated).format('YYYY-MM-DD HH:mm') : '',
    'Склад': o.warehouse_name || '',
    'Регион': o.region || '',
    'Размер': o.size || '',
    'Бренд': o.brand || '',
    'Категория': o.category || '',
    'Предмет': o.subject || '',
    'Цена': o.price,
    'Скидка, %': o.discount_percent,
    'СПП, %': o.spp,
    'Цена со скидкой': o.price_with_disc,
    'К перечислению': o.finished_price,
    'Статус': o.status,
    'Отменён': o.is_cancel ? 'Да' : 'Нет',
    'Дней доставки': (o as any).delivery_days ?? '',
  }));

  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'ID заказа': 'Нет данных' }]);
  ws['!cols'] = [
    { wch: 15 }, { wch: 12 }, { wch: 18 }, { wch: 18 },
    { wch: 20 }, { wch: 20 }, { wch: 10 }, { wch: 15 },
    { wch: 15 }, { wch: 15 }, { wch: 10 }, { wch: 10 },
    { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 10 },
    { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Лента заказов');
}

// === Sheet 3: Остатки ===
async function addStocksSheet(
  wb: XLSX.WorkBook,
  nmId?: number
): Promise<void> {
  let rows: any[] = [];

  if (nmId) {
    const stocks = await stockRepo.getStocksByNmId(nmId);
    rows = stocks.map(s => ({
      'Артикул': s.nm_id,
      'Артикул продавца': s.supplier_article || '',
      'Размер': s.tech_size || '',
      'Баркод': s.barcode || '',
      'Склад': s.warehouse_name || '',
      'На складе': s.quantity,
      'В пути к клиенту': s.in_way_to_client,
      'В пути возврат': s.in_way_from_client,
      'Полный остаток': s.quantity_full,
      'Категория': s.category || '',
      'Бренд': s.brand || '',
      'Цена': s.price,
      'Скидка': s.discount,
      'Дата последнего изменения': s.last_change_date ? dayjs(s.last_change_date).format('YYYY-MM-DD HH:mm') : '',
    }));
  } else {
    const summary = await stockRepo.getStocksSummary();
    rows = summary.map(s => ({
      'Артикул': s.nm_id,
      'Артикул продавца': s.supplier_article || '',
      'Бренд': s.brand || '',
      'Предмет': s.subject || '',
      'На складе (всего)': s.total_quantity,
      'В пути к клиенту': s.total_in_way_to_client,
      'В пути возврат': s.total_in_way_from_client,
      'Полный остаток': s.total_quantity_full,
      'Складов': s.warehouses_count,
      'Размеров': s.sizes_count,
    }));
  }

  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'Артикул': 'Нет данных' }]);
  ws['!cols'] = Array(14).fill({ wch: 15 });
  XLSX.utils.book_append_sheet(wb, ws, 'Остатки');
}

// === Sheet 4: Воронка по точкам входа ===
async function addTrafficSourcesSheet(
  wb: XLSX.WorkBook,
  dateFrom: string,
  dateTo: string,
  nmId?: number
): Promise<void> {
  let rows: any[] = [];

  if (nmId) {
    const sources = await trafficRepo.getTrafficSourcesByNmId(nmId, dateFrom, dateTo);
    rows = sources.map(s => ({
      'Артикул': s.nm_id,
      'Дата': dayjs(s.date).format('YYYY-MM-DD'),
      'Источник': s.source_name,
      'Просмотры': s.open_card_count,
      'В корзину': s.add_to_cart_count,
      'Заказы': s.orders_count,
      'Сумма заказов': s.orders_sum,
      'Выкупы': s.buyouts_count,
      'Отмены': s.cancel_count,
    }));
  } else {
    // For all products, show summary by source
    const products = await repo.getProducts();
    for (const product of products) {
      const summary = await trafficRepo.getTrafficSourcesSummary(product.nm_id, dateFrom, dateTo);
      for (const s of summary) {
        rows.push({
          'Артикул': product.nm_id,
          'Название': product.name || '',
          'Источник': s.source_name,
          'Просмотры': s.total_views,
          'В корзину': s.total_cart,
          'Заказы': s.total_orders,
          'Сумма заказов': s.total_orders_sum,
          'Выкупы': s.total_buyouts,
          'Отмены': s.total_cancels,
          'Конверсия в корзину, %': s.conversion_to_cart,
          'Конверсия в заказ, %': s.conversion_to_order,
        });
      }
    }
  }

  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'Артикул': 'Нет данных по источникам трафика' }]);
  ws['!cols'] = Array(11).fill({ wch: 15 });
  XLSX.utils.book_append_sheet(wb, ws, 'Точки входа');
}

// === Sheet 5: Маркетинговая активность ===
async function addMarketingEventsSheet(
  wb: XLSX.WorkBook,
  dateFrom: string,
  dateTo: string,
  nmId?: number
): Promise<void> {
  const events = nmId
    ? await eventsRepo.getEventsByNmId(nmId, dateFrom, dateTo)
    : await eventsRepo.getAllEvents(dateFrom, dateTo);

  const eventTypeLabels: Record<string, string> = {
    price_change: 'Изменение цены',
    photo_update: 'Обновление фото',
    description_update: 'Обновление описания',
    promotion_start: 'Начало акции',
    promotion_end: 'Конец акции',
    seo_update: 'SEO обновление',
    new_review_response: 'Ответ на отзыв',
    stock_replenishment: 'Пополнение склада',
    other: 'Другое',
  };

  const rows = events.map(e => ({
    'Артикул': e.nm_id,
    'Дата': dayjs(e.event_date).format('YYYY-MM-DD'),
    'Тип события': eventTypeLabels[e.event_type] || e.event_type,
    'Описание': e.description || '',
    'Дата создания': dayjs(e.created_at).format('YYYY-MM-DD HH:mm'),
  }));

  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'Артикул': 'Нет маркетинговых событий' }]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 50 }, { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Маркетинг');
}

// === Sheet 6: Рекламные компании ===
async function addCampaignsSheet(
  wb: XLSX.WorkBook,
  dateFrom: string,
  dateTo: string
): Promise<void> {
  const campaigns = await repo.getCampaigns();
  const rows: any[] = [];

  for (const campaign of campaigns) {
    const stats = await repo.getCampaignStats(campaign.campaign_id, dateFrom, dateTo);

    if (stats.length === 0) {
      rows.push({
        'ID': campaign.campaign_id,
        'Название': campaign.name,
        'Тип': campaign.type,
        'Статус': campaign.status,
        'Дневной бюджет': campaign.daily_budget,
        'Дата': '',
        'Показы': 0,
        'Клики': 0,
        'CTR, %': 0,
        'CPC': 0,
        'CPM': 0,
        'Расход': 0,
        'Заказы': 0,
        'Сумма заказов': 0,
        'ROAS': 0,
      });
      continue;
    }

    for (const day of stats) {
      const roas = day.spend > 0 ? day.order_sum / day.spend : 0;
      rows.push({
        'ID': campaign.campaign_id,
        'Название': campaign.name,
        'Тип': campaign.type,
        'Статус': campaign.status,
        'Дневной бюджет': campaign.daily_budget,
        'Дата': dayjs(day.date).format('YYYY-MM-DD'),
        'Показы': day.views,
        'Клики': day.clicks,
        'CTR, %': day.ctr,
        'CPC': day.cpc,
        'CPM': day.cpm,
        'Расход': day.spend,
        'Заказы': day.orders,
        'Сумма заказов': day.order_sum,
        'ROAS': Math.round(roas * 100) / 100,
      });
    }
  }

  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'ID': 'Нет данных о кампаниях' }]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 15 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 15 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Рекламные компании');
}

// === Sheet 7: Кластеры (Keywords + Search Query Analytics) ===
async function addKeywordsSheet(
  wb: XLSX.WorkBook,
  dateFrom?: string,
  dateTo?: string,
  nmId?: number
): Promise<void> {
  // Try search_query_analytics first (richer data from Seller Analytics)
  const searchData = nmId
    ? await searchRepo.getSearchQuerySummary(nmId, dateFrom, dateTo)
    : await searchRepo.getAllSearchQuerySummary(dateFrom, dateTo);

  const rows: any[] = [];

  if (searchData.length > 0) {
    // Use rich search analytics data
    for (const s of searchData) {
      rows.push({
        'Артикул': s.nm_id,
        'Ключевой запрос': s.keyword,
        'Ср. позиция': s.avg_position ?? '-',
        'Показы': Number(s.total_impressions) || 0,
        'Переходы': Number(s.total_visits) || 0,
        'CTR, %': s.avg_ctr ?? 0,
        'В корзину': Number(s.total_cart_adds) || 0,
        'Заказы': Number(s.total_orders) || 0,
        'Видимость, %': s.avg_visibility ?? 0,
      });
    }
  } else {
    // Fallback to keyword_collections + keyword_positions (manual tracking)
    const allKeywords = nmId
      ? await keywordsRepo.getKeywords(nmId)
      : await keywordsRepo.getAllTrackedKeywords();

    for (const kw of allKeywords) {
      const positions = await keywordsRepo.getKeywordPositions(kw.nm_id, kw.keyword, 1);
      const latestPosition = positions[0];

      rows.push({
        'Артикул': kw.nm_id,
        'Ключевой запрос': kw.keyword,
        'Ср. позиция': latestPosition?.position || '-',
        'Показы': kw.frequency || 0,
        'Переходы': '-',
        'CTR, %': '-',
        'В корзину': '-',
        'Заказы': '-',
        'Видимость, %': '-',
      });
    }
  }

  const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ 'Артикул': 'Нет данных о ключевых словах' }]);
  ws['!cols'] = [
    { wch: 12 }, { wch: 35 }, { wch: 12 }, { wch: 10 },
    { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Кластеры');
}
