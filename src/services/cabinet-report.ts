/**
 * Cabinet daily report generator.
 * Builds a Telegram-formatted summary of orders + ad spend + CPO per product
 * since Moscow midnight. Used by:
 *   - 15-min scheduler task (automatic)
 *   - Webhook endpoint triggered by WBPartners-Auto on new-order detection
 */

import dayjs from 'dayjs';
import * as repo from '../db/repository';
import * as monitoringRepo from '../db/monitoring-repository';
import * as cabinetsRepo from '../db/cabinets-repository';
import { sendTelegramMessage } from './telegram-notifier';

const MSK_OFFSET_HOURS = 3;

function formatRubles(kopecksOrRubles: number): string {
  // Input is already in rubles from campaign_expenses.upd_sum
  const rubles = Math.round(kopecksOrRubles);
  return rubles.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
}

/**
 * Build the report text for a cabinet. Returns null if there's nothing to report.
 */
export async function generateCabinetReport(cabinetId: number): Promise<string | null> {
  const cabinet = await cabinetsRepo.getCabinetById(cabinetId);
  if (!cabinet) return null;

  // Moscow midnight boundaries (same logic as monitoring-routes.ts:23-32)
  const now = dayjs();
  const nowMsk = now.add(MSK_OFFSET_HOURS, 'hour');
  const mskToday = nowMsk.startOf('day');
  const todayStart = mskToday.subtract(MSK_OFFSET_HOURS, 'hour').format('YYYY-MM-DD HH:mm:ss');
  const tomorrowStart = mskToday.add(1, 'day').subtract(MSK_OFFSET_HOURS, 'hour').format('YYYY-MM-DD HH:mm:ss');

  const products = await repo.getProducts(cabinetId);

  type Row = {
    vendorCode: string;
    nmId: number;
    orders: number;
    spend: number;
    cpo: number | null;
  };
  const rows: Row[] = [];
  let totalOrders = 0;
  let totalSpend = 0;

  for (const product of products) {
    const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, product.nm_id);
    const campaignIds = campaigns.map(c => c.campaign_id);

    const orders = await monitoringRepo.getOrderCountForProduct(
      cabinetId,
      product.nm_id,
      todayStart,
      tomorrowStart
    );
    const spend = await monitoringRepo.getSpendForCampaigns(
      cabinetId,
      campaignIds,
      todayStart,
      tomorrowStart
    );

    // Skip products with zero activity
    if (orders === 0 && spend === 0) continue;

    const cpo = orders > 0 ? Math.round(spend / orders) : null;
    rows.push({
      vendorCode: product.vendor_code || String(product.nm_id),
      nmId: product.nm_id,
      orders,
      spend,
      cpo,
    });
    totalOrders += orders;
    totalSpend += spend;
  }

  if (rows.length === 0) return null;

  // Sort by orders DESC
  rows.sort((a, b) => b.orders - a.orders);

  const timestamp = nowMsk.format('DD.MM HH:mm');
  const header = `📊 <b>${cabinet.name}</b> | ${timestamp} МСК\n`;
  const tableHeader = '\n<b>Артикул | Заказы | Бюджет | CPO</b>';
  const body = rows
    .map(r => {
      const cpoStr = r.cpo != null ? formatRubles(r.cpo) : '—';
      return `<code>${r.vendorCode}</code> | ${r.orders} шт | ${formatRubles(r.spend)} | ${cpoStr}`;
    })
    .join('\n');

  const totalCpo = totalOrders > 0 ? Math.round(totalSpend / totalOrders) : null;
  const totalCpoStr = totalCpo != null ? formatRubles(totalCpo) : '—';
  const footer = `\n──────────────\n<b>Итого:</b> ${totalOrders} шт | ${formatRubles(totalSpend)} | CPO ${totalCpoStr}`;

  return header + tableHeader + '\n' + body + footer;
}

/**
 * Generate and send report for a single cabinet. Used by webhook.
 */
export async function sendCabinetReport(cabinetId: number): Promise<boolean> {
  const msg = await generateCabinetReport(cabinetId);
  if (!msg) return false;
  await sendTelegramMessage(msg);
  return true;
}
