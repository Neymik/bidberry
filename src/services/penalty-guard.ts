/**
 * Warehouse penalty & dimension-re-measure monitor.
 *
 * Pulls WB's financial detail report (reportDetailByPeriod — the ONLY place WB
 * exposes penalties and габарит/перемер adjustments tied to a product), stores
 * every relevant line in `warehouse_penalties`, and sends ONE Telegram alert
 * per cabinet listing newly-appeared PROBLEMS.
 *
 * Why group-level, not line-level: WB charges things like "Занижение
 * фактических габаритов упаковки товара" once per shipped unit, so one problem
 * produces hundreds of identical lines and keeps producing more every week.
 * Alerting per line would dump thousands of rows and re-spam every cycle.
 * Instead we alert once per (product × reason) group the first time it ever
 * appears — that's the real "a new charge showed up" signal. Ongoing accrual of
 * an already-known group accumulates silently in the table (for dashboards).
 *
 * Source caveat (matters for expectations): this report is WB's WEEKLY
 * settlement of реализация, propagated with a lag of up to a week. NOT realtime
 * like phone orders — it's "a new charge appeared in a fresh report", not
 * "the warehouse just measured your box". The phone (WBPartners-Auto) cannot
 * see these; they are money movements, API-only.
 *
 * What counts:
 *   • penalty   — any report line with penalty != 0 (marking/packaging/…); WB
 *                 also issues negative penalties (reversals), kept for accuracy.
 *   • dimension — any line whose reason mentions габарит / перемер (the warehouse
 *                 re-measured the item and re-charged), even with penalty == 0.
 *
 * Env knobs (all optional):
 *   PENALTY_GUARD_ENABLED        default "true"
 *   PENALTY_GUARD_LOOKBACK_DAYS  default 14   (report period back-window)
 *   PENALTY_GUARD_MAX_LINES_MSG  default 40   (group lines per message; rest summarised)
 *   PENALTY_GUARD_REQ_DELAY_MS   default 61000 (delay between WB requests — endpoint is ~1 req/min)
 */

import dayjs from 'dayjs';
import * as cabinetsRepo from '../db/cabinets-repository';
import { getWBClientForCabinet } from '../api/wb-client';
import * as penaltyRepo from '../db/penalty-repository';
import { groupKey, type PenaltyRow } from '../db/penalty-repository';
import { sendTelegramMessage } from './telegram-notifier';

const DIMENSION_RE = /габарит|перемер/i;

export interface PenaltyGuardConfig {
  enabled: boolean;
  lookbackDays: number;
  maxLinesPerMsg: number;
  reqDelayMs: number;
}

/** Aggregated view of one (product × reason) problem within a batch. */
export interface PenaltyGroup {
  key: string;
  product: string; // sa_name, or "nm <id>", or "—"
  reason: string;
  kind: 'penalty' | 'dimension';
  count: number; // number of report lines
  sum: number; // total penalty ₽ (can be negative)
}

function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function getConfigFromEnv(): PenaltyGuardConfig {
  return {
    enabled: (process.env.PENALTY_GUARD_ENABLED ?? 'true').toLowerCase() !== 'false',
    lookbackDays: numEnv('PENALTY_GUARD_LOOKBACK_DAYS', 14),
    maxLinesPerMsg: numEnv('PENALTY_GUARD_MAX_LINES_MSG', 40),
    reqDelayMs: numEnv('PENALTY_GUARD_REQ_DELAY_MS', 61000),
  };
}

/**
 * Pure classifier: turn one raw WB report line into a PenaltyRow we care about,
 * or null if it's neither a penalty nor a dimension adjustment. No I/O — unit-tested.
 */
export function classifyReportRow(raw: any, cabinetId: number): PenaltyRow | null {
  const rrdId = Number(raw?.rrd_id);
  if (!Number.isFinite(rrdId) || rrdId <= 0) return null;

  const penalty = Number(raw?.penalty) || 0;
  const bonusType: string = raw?.bonus_type_name ?? '';
  const operName: string = raw?.supplier_oper_name ?? '';
  const isDimension = DIMENSION_RE.test(bonusType) || DIMENSION_RE.test(operName);
  const isPenalty = penalty !== 0;

  if (!isPenalty && !isDimension) return null;

  return {
    cabinetId,
    rrdId,
    nmId: raw?.nm_id != null ? Number(raw.nm_id) : null,
    saName: raw?.sa_name ?? null,
    subjectName: raw?.subject_name ?? null,
    bonusTypeName: bonusType || null,
    supplierOperName: operName || null,
    penalty,
    rrDt: raw?.rr_dt ? String(raw.rr_dt).slice(0, 10) : null,
    // A line can be both; dimension is the rarer/important signal, so tag it first.
    kind: isDimension ? 'dimension' : 'penalty',
  };
}

/** Aggregate classified lines into (product × reason) groups. Pure — unit-tested. */
export function aggregateGroups(rows: PenaltyRow[]): Map<string, PenaltyGroup> {
  const groups = new Map<string, PenaltyGroup>();
  for (const r of rows) {
    const key = groupKey(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        product: r.saName || (r.nmId != null ? `nm ${r.nmId}` : '—'),
        reason: (r.bonusTypeName || r.supplierOperName || '').trim(),
        kind: r.kind,
        count: 0,
        sum: 0,
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.sum += r.penalty;
    if (r.kind === 'dimension') g.kind = 'dimension'; // dimension wins the group tag
  }
  return groups;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Fetch the full detail report for [dateFrom, dateTo], paginating by rrd_id.
 * Adds reqDelayMs between page requests (endpoint is rate-limited to ~1/min).
 */
async function fetchAllReportRows(
  wb: ReturnType<typeof getWBClientForCabinet>,
  dateFrom: string,
  dateTo: string,
  reqDelayMs: number
): Promise<any[]> {
  const all: any[] = [];
  let rrdid = 0;
  // Safety cap: avoid an infinite loop if WB never returns an empty page.
  for (let page = 0; page < 50; page++) {
    const rows = await wb.getReportDetailByPeriod(dateFrom, dateTo, rrdid);
    if (rows.length === 0) break;
    all.push(...rows);
    const last = rows[rows.length - 1]?.rrd_id;
    if (last == null || Number(last) === rrdid) break; // no progress → stop
    rrdid = Number(last);
    if (rows.length < 100000) break; // last page (we requested the max limit)
    await sleep(reqDelayMs);
  }
  return all;
}

function fmtRub(amount: number): string {
  const rounded = Math.round(amount);
  return rounded.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
}

export function formatPenaltyAlert(
  cabinetName: string,
  newGroups: PenaltyGroup[],
  maxLines: number
): string {
  const dims = newGroups.filter(g => g.kind === 'dimension');
  const pens = newGroups.filter(g => g.kind === 'penalty');
  const total = newGroups.reduce((s, g) => s + g.sum, 0);

  const header =
    `🏬 <b>Новые штрафы / габариты от склада</b> | ${cabinetName}\n` +
    `Новых проблем: <b>${newGroups.length}</b>` +
    (dims.length ? ` (перемер габаритов: ${dims.length})` : '') +
    ` | сумма ${fmtRub(total)}`;

  const lines: string[] = [header];
  // Dimension groups first (the signal the user specifically asked about),
  // then penalties; biggest sum first within each.
  const ordered = [...dims, ...pens].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));
  for (const g of ordered.slice(0, maxLines)) {
    const icon = g.kind === 'dimension' ? '📦' : '⚠️';
    lines.push(
      `${icon} <code>${g.product}</code> — ${fmtRub(g.sum)} · ${g.count} шт${g.reason ? ` · ${g.reason}` : ''}`
    );
  }
  const hidden = ordered.length - Math.min(ordered.length, maxLines);
  if (hidden > 0) lines.push(`…и ещё ${hidden}`);

  lines.push('<i>Источник: финотчёт WB (еженедельный, с лагом)</i>');
  return lines.join('\n');
}

let _disabledLogged = false;

/**
 * One monitor pass over all active cabinets. Registered as the `penalty-guard`
 * scheduled task. Stores all relevant lines and alerts once per (product×reason)
 * group the first time it appears.
 */
export async function runPenaltyGuard(): Promise<void> {
  const cfg = getConfigFromEnv();
  if (!cfg.enabled) {
    if (!_disabledLogged) {
      console.log('[penalty-guard] disabled (PENALTY_GUARD_ENABLED=false)');
      _disabledLogged = true;
    }
    return;
  }
  _disabledLogged = false;

  await penaltyRepo.ensureSchema();

  const dateTo = dayjs().format('YYYY-MM-DD');
  const dateFrom = dayjs().subtract(cfg.lookbackDays, 'day').format('YYYY-MM-DD');

  const cabinets = await cabinetsRepo.getActiveCabinets();
  let first = true;
  for (const cab of cabinets) {
    try {
      // Space out cabinets too — the endpoint is rate-limited per API key.
      if (!first) await sleep(cfg.reqDelayMs);
      first = false;

      const wb = getWBClientForCabinet(cab.id, cab.wb_api_key);
      const rawRows = await fetchAllReportRows(wb, dateFrom, dateTo, cfg.reqDelayMs);

      const relevant: PenaltyRow[] = [];
      for (const raw of rawRows) {
        const row = classifyReportRow(raw, cab.id);
        if (row) relevant.push(row);
      }
      if (relevant.length === 0) continue;

      // Which problem-groups already existed BEFORE we store this batch.
      const existingGroups = await penaltyRepo.getExistingGroupKeys(cab.id);
      const inserted = await penaltyRepo.insertPenalties(relevant);

      const newGroups = [...aggregateGroups(relevant).values()].filter(
        g => !existingGroups.has(g.key)
      );

      console.log(
        `[penalty-guard] cabinet ${cab.id} (${cab.name}): ${relevant.length} lines (${inserted} new), ${newGroups.length} new problem group(s)`
      );

      if (newGroups.length > 0) {
        await sendTelegramMessage(formatPenaltyAlert(cab.name, newGroups, cfg.maxLinesPerMsg));
      }
    } catch (error: any) {
      console.error(`[penalty-guard] failed for cabinet ${cab.id} (${cab.name}): ${error.message}`);
    }
  }
}
