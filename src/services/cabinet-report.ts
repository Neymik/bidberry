/**
 * Cabinet daily report generator.
 *
 * Source of truth for ORDERS: WBPartners-Auto phone scraping DB (read-only
 * mount). WB API undercounts and lags, so we don't use it for order data.
 *
 * Source for AD SPEND: bidberry's own tables (campaign_budget_snapshots,
 * campaign_expenses) populated from the WB Advert API — the only way to
 * observe spend, since the phone doesn't see it.
 */

import dayjs from 'dayjs';
import * as monitoringRepo from '../db/monitoring-repository';
import * as cabinetsRepo from '../db/cabinets-repository';
import { sendTelegramMessage } from './telegram-notifier';
import { getPhoneTotalsByArticle } from './wbpartners-phone-db';

const MSK_OFFSET_HOURS = 3;

function formatRubles(amount: number): string {
  const rubles = Math.round(amount);
  return rubles.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
}

/**
 * Optional explicit MSK wall-clock window for the report. `start`/`end` are
 * "YYYY-MM-DD HH:mm:ss" SQL format (half-open: start inclusive, end exclusive).
 * `label` is what appears in the message header instead of the default
 * "now МСК" stamp.
 */
export type ReportRange = {
  start: string;
  end: string;
  label: string;
};

/**
 * Build the report text for a cabinet. Returns null if there's nothing to report.
 * Without `range`, reports on "today from Moscow midnight" (the default the
 * scheduler and trigger webhook use).
 */
export async function generateCabinetReport(
  cabinetId: number,
  range?: ReportRange,
): Promise<string | null> {
  const cabinet = await cabinetsRepo.getCabinetById(cabinetId);
  if (!cabinet) return null;

  // Moscow midnight boundaries. All bidberry DATETIME columns are stored as
  // Moscow wall-clock (see db/monitoring-repository.ts timezone helpers).
  // The phone DB uses `date_parsed` which is also MSK wall-clock, stored as
  // ISO string without TZ. So one MSK range covers both sources.
  const nowMsk = dayjs().add(MSK_OFFSET_HOURS, 'hour');
  const mskToday = nowMsk.startOf('day');
  const defaultStartSql = mskToday.format('YYYY-MM-DD HH:mm:ss');
  const defaultEndSql = mskToday.add(1, 'day').format('YYYY-MM-DD HH:mm:ss');

  const startSql = range?.start ?? defaultStartSql;
  const endSql = range?.end ?? defaultEndSql;
  // Phone DB stores date_parsed in ISO format with 'T' separator
  const startIso = startSql.replace(' ', 'T');
  const endIso = endSql.replace(' ', 'T');
  const headerLabel = range?.label ?? `${nowMsk.format('DD.MM HH:mm')} МСК`;

  // 1. Orders from the phone (authoritative source)
  const phoneTotals = getPhoneTotalsByArticle(startIso, endIso);
  if (phoneTotals.length === 0) return null;

  // 2. Ad spend + WB API orders per product
  //    spend       — bidberry tables, from WB Advert API
  //    apiOrders   — bidberry `orders` table, from WB Statistics API
  //    phoneOrders — authoritative, used for CPC calculation
  type Row = {
    vendorCode: string;
    article: string;
    phoneOrders: number;
    apiOrders: number;
    spend: number;
    cpo: number | null;
  };
  const rows: Row[] = [];
  let totalPhoneOrders = 0;
  let totalApiOrders = 0;
  let totalSpend = 0;

  for (const pt of phoneTotals) {
    const nmId = Number(pt.article);
    let spend = 0;
    let apiOrders = 0;
    if (!Number.isNaN(nmId)) {
      const campaigns = await monitoringRepo.getCampaignsForProduct(cabinetId, nmId);
      const campaignIds = campaigns.map(c => c.campaign_id);

      // Prefer snapshot-based spend (more real-time), fall back to expense
      // history if snapshots haven't accumulated yet (early in the day).
      const snapshotHours = await monitoringRepo.getHourlySpendFromSnapshots(
        cabinetId,
        campaignIds,
        startSql,
        endSql
      );
      const snapshotSpend = snapshotHours.reduce((s, h) => s + h.spend, 0);
      const expenseSpend = await monitoringRepo.getSpendForCampaigns(
        cabinetId,
        campaignIds,
        startSql,
        endSql
      );
      spend = Math.max(snapshotSpend, expenseSpend);

      apiOrders = await monitoringRepo.getOrderCountForProduct(
        cabinetId,
        nmId,
        startSql,
        endSql
      );
    }

    // CPO denominator = phone orders (authoritative). API undercounts ~14%.
    const cpo = pt.orders > 0 ? Math.round(spend / pt.orders) : null;
    rows.push({
      vendorCode: pt.vendorCode,
      article: pt.article,
      phoneOrders: pt.orders,
      apiOrders,
      spend,
      cpo,
    });
    totalPhoneOrders += pt.orders;
    totalApiOrders += apiOrders;
    totalSpend += spend;
  }

  // Sort by phone orders DESC
  rows.sort((a, b) => b.phoneOrders - a.phoneOrders);

  const header = `📊 <b>${cabinet.name}</b> | ${headerLabel}\n`;
  const tableHeader = '\n<b>Артикул | Заказы тел/API | Бюджет | CPO</b>';
  const body = rows
    .map(r => {
      const cpoStr = r.cpo != null ? formatRubles(r.cpo) : '—';
      return `<code>${r.vendorCode}</code> | ${r.phoneOrders}/${r.apiOrders} шт | ${formatRubles(r.spend)} | ${cpoStr}`;
    })
    .join('\n');

  const totalCpo = totalPhoneOrders > 0 ? Math.round(totalSpend / totalPhoneOrders) : null;
  const totalCpoStr = totalCpo != null ? formatRubles(totalCpo) : '—';
  const footer =
    `\n──────────────\n` +
    `<b>Итого:</b> ${totalPhoneOrders}/${totalApiOrders} шт | ${formatRubles(totalSpend)} | CPO ${totalCpoStr}\n` +
    `<i>* CPO = бюджет / заказы с телефона</i>`;

  return header + tableHeader + '\n' + body + footer;
}

// Per-cabinet send cooldown. Telegram bots have rate limits and the trigger
// webhook can fire on every order — without this, a burst of orders becomes
// a burst of Telegram messages and we get rate-limited.
const COOLDOWN_MS = 60_000;
const lastSentByCabinet = new Map<number, number>();

/** Test helper — clears cooldown state. Do not call from production code. */
export function _resetCooldownForTests() {
  lastSentByCabinet.clear();
}

/**
 * Generate and send report for a single cabinet. Used by webhook + scheduler.
 * Returns false if the cooldown is active or there's nothing to report.
 */
export async function sendCabinetReport(cabinetId: number): Promise<boolean> {
  const now = Date.now();
  const lastSent = lastSentByCabinet.get(cabinetId) || 0;
  if (now - lastSent < COOLDOWN_MS) {
    console.log(`[cabinet-report] cabinet ${cabinetId} cooldown active (${Math.round((COOLDOWN_MS - (now - lastSent)) / 1000)}s remaining)`);
    return false;
  }

  const msg = await generateCabinetReport(cabinetId);
  if (!msg) return false;

  // Mark as sent BEFORE awaiting send so concurrent invocations are debounced
  // even if Telegram is slow.
  lastSentByCabinet.set(cabinetId, now);
  await sendTelegramMessage(msg);
  return true;
}
