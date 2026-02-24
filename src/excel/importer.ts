import * as XLSX from 'xlsx';
import {
  upsertCampaign,
  upsertProduct,
  createImportRecord,
  updateImportRecord,
} from '../db/repository';
import type { WBCampaign } from '../types';

interface ImportResult {
  success: boolean;
  recordsImported: number;
  errors: string[];
}

// === ИМПОРТ КАМПАНИЙ ИЗ EXCEL ===

export async function importCampaignsFromExcel(
  filePath: string
): Promise<ImportResult> {
  const importId = await createImportRecord('campaigns', filePath);
  const errors: string[] = [];
  let recordsImported = 0;

  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0]!;
    const sheet = workbook.Sheets[sheetName]!;
    const data = XLSX.utils.sheet_to_json(sheet) as any[];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        const campaign = mapRowToCampaign(row);
        if (campaign) {
          await upsertCampaign(campaign);
          recordsImported++;
        }
      } catch (err: any) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    await updateImportRecord(
      importId,
      errors.length === 0 ? 'completed' : 'completed_with_errors',
      recordsImported,
      errors.join('\n')
    );

    return { success: true, recordsImported, errors };
  } catch (err: any) {
    await updateImportRecord(importId, 'failed', 0, err.message);
    return { success: false, recordsImported: 0, errors: [err.message] };
  }
}

// === ИМПОРТ ТОВАРОВ ИЗ EXCEL ===

export async function importProductsFromExcel(
  filePath: string
): Promise<ImportResult> {
  const importId = await createImportRecord('products', filePath);
  const errors: string[] = [];
  let recordsImported = 0;

  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0]!;
    const sheet = workbook.Sheets[sheetName]!;
    const data = XLSX.utils.sheet_to_json(sheet) as any[];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        const product = mapRowToProduct(row);
        if (product) {
          await upsertProduct(product);
          recordsImported++;
        }
      } catch (err: any) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    await updateImportRecord(
      importId,
      errors.length === 0 ? 'completed' : 'completed_with_errors',
      recordsImported,
      errors.join('\n')
    );

    return { success: true, recordsImported, errors };
  } catch (err: any) {
    await updateImportRecord(importId, 'failed', 0, err.message);
    return { success: false, recordsImported: 0, errors: [err.message] };
  }
}

// === ИМПОРТ СТАВОК ИЗ EXCEL ===

export interface BidImportRow {
  keyword: string;
  bid: number;
}

export async function parseBidsFromExcel(filePath: string): Promise<BidImportRow[]> {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0]!;
  const sheet = workbook.Sheets[sheetName]!;
  const data = XLSX.utils.sheet_to_json(sheet) as any[];

  return data
    .map(row => ({
      keyword: row['Ключевое слово'] || row['keyword'] || row['Keyword'],
      bid: parseFloat(row['Ставка'] || row['bid'] || row['Bid'] || 0),
    }))
    .filter(b => b.keyword && b.bid > 0);
}

// === GENERIC IMPORT ===

export async function importFromExcel<T>(
  filePath: string,
  mapper: (row: any) => T | null,
  processor: (item: T) => Promise<void>
): Promise<ImportResult> {
  const errors: string[] = [];
  let recordsImported = 0;

  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0]!;
    const sheet = workbook.Sheets[sheetName]!;
    const data = XLSX.utils.sheet_to_json(sheet) as any[];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        const item = mapper(row);
        if (item) {
          await processor(item);
          recordsImported++;
        }
      } catch (err: any) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    }

    return { success: true, recordsImported, errors };
  } catch (err: any) {
    return { success: false, recordsImported: 0, errors: [err.message] };
  }
}

// === MAPPERS ===

function mapRowToCampaign(row: any): WBCampaign | null {
  const campaignId = row['ID Кампании'] || row['campaign_id'] || row['advertId'];
  if (!campaignId) return null;

  return {
    advertId: parseInt(campaignId),
    name: row['Название'] || row['name'] || '',
    type: mapCampaignType(row['Тип'] || row['type']),
    status: mapCampaignStatus(row['Статус'] || row['status']),
    dailyBudget: parseFloat(row['Дневной бюджет'] || row['dailyBudget'] || 0),
    createTime: row['createTime'] || new Date().toISOString(),
    changeTime: row['changeTime'] || new Date().toISOString(),
    startTime: row['startTime'] || '',
    endTime: row['endTime'] || '',
  };
}

function mapRowToProduct(row: any): {
  nmId: number;
  vendorCode?: string;
  brand?: string;
  subject?: string;
  name?: string;
  price?: number;
  discount?: number;
  finalPrice?: number;
} | null {
  const nmId = row['Артикул WB'] || row['nm_id'] || row['nmId'];
  if (!nmId) return null;

  return {
    nmId: parseInt(nmId),
    vendorCode: row['Артикул продавца'] || row['vendor_code'] || row['vendorCode'],
    brand: row['Бренд'] || row['brand'],
    subject: row['Категория'] || row['subject'],
    name: row['Название'] || row['name'],
    price: parseFloat(row['Цена'] || row['price'] || 0) || undefined,
    discount: parseInt(row['Скидка'] || row['discount'] || 0) || undefined,
    finalPrice: parseFloat(row['Цена со скидкой'] || row['finalPrice'] || 0) || undefined,
  };
}

function mapCampaignType(type: string | number): number {
  if (typeof type === 'number') return type;

  const typeMap: Record<string, number> = {
    'Каталог': 4,
    'Карточка товара': 5,
    'Поиск': 6,
    'Рекомендации': 7,
    'Авто': 8,
    'Поиск + каталог': 9,
  };

  return typeMap[type] || 8;
}

function mapCampaignStatus(status: string | number): number {
  if (typeof status === 'number') return status;

  const statusMap: Record<string, number> = {
    'Удалена': -1,
    'Готова к запуску': 4,
    'Завершена': 7,
    'Отказано': 8,
    'Активна': 9,
    'Приостановлена': 11,
  };

  return statusMap[status] || 4;
}

// === TEMPLATE GENERATION ===

export function generateCampaignTemplate(): Buffer {
  const template = [
    {
      'ID Кампании': 12345678,
      'Название': 'Пример кампании',
      'Тип': 'Авто',
      'Статус': 'Активна',
      'Дневной бюджет': 1000,
    },
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(template);
  XLSX.utils.book_append_sheet(wb, ws, 'Кампании');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

export function generateProductTemplate(): Buffer {
  const template = [
    {
      'Артикул WB': 123456789,
      'Артикул продавца': 'VENDOR-001',
      'Бренд': 'Мой бренд',
      'Категория': 'Одежда',
      'Название': 'Пример товара',
      'Цена': 1500,
      'Скидка': 10,
    },
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(template);
  XLSX.utils.book_append_sheet(wb, ws, 'Товары');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

export function generateBidsTemplate(): Buffer {
  const template = [
    { 'Ключевое слово': 'платье летнее', 'Ставка': 150 },
    { 'Ключевое слово': 'платье женское', 'Ставка': 200 },
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(template);
  XLSX.utils.book_append_sheet(wb, ws, 'Ставки');

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
