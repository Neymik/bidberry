/**
 * Realtime CPO guard (alert-only — milestone ① of "stop/adjust campaigns when
 * CPO is too high").
 *
 * Every 15 min during ad hours it computes today's per-product CPO for each
 * cabinet (reusing computeCabinetCpo — phone orders ÷ ad spend, the same math
 * as the cabinet report) and sends ONE Telegram alert listing products whose
 * CPO is out of line. No campaign changes are made yet; later milestones add
 * auto bid-down and auto-pause.
 *
 * Ceiling model (zero-config by default, self-calibrating):
 *   • relative — a product's CPO ≥ ratio × the cabinet's blended CPO today
 *     (and above an absolute floor, so "3× a tiny average" doesn't fire).
 *   • absolute — optional hard ceiling in ₽, off by default.
 *
 * Noise guards: minimum product + cabinet order volume (CPO is meaningless on
 * thin data), active-hours window (morning spend leads orders — CPO reads high
 * before orders land), a consecutive-breach streak (sustained, not a spike),
 * and a per-product re-alert cooldown. Streak/cooldown state is in-memory
 * (reset on restart — acceptable for an alerter).
 *
 * Env knobs (all optional):
 *   CPO_GUARD_ENABLED            default "true"
 *   CPO_GUARD_RATIO              default 3      (relative ceiling; 0 disables relative)
 *   CPO_GUARD_ABS_MIN_RUB        default 150    (floor under the relative rule)
 *   CPO_GUARD_ABS_CEILING_RUB    default 0      (hard ceiling; 0 disables absolute)
 *   CPO_GUARD_MIN_ORDERS         default 3      (per-product min orders)
 *   CPO_GUARD_MIN_CABINET_ORDERS default 10     (min orders for a meaningful blended CPO)
 *   CPO_GUARD_STREAK             default 2      (consecutive 15-min checks before alerting)
 *   CPO_GUARD_REALERT_MIN        default 120    (per-product re-alert cooldown, minutes)
 *   CPO_GUARD_ACTIVE_HOURS       default "10-23" (MSK hour window, end-exclusive)
 */

import dayjs from 'dayjs';
import * as cabinetsRepo from '../db/cabinets-repository';
import { computeCabinetCpo, type CpoBreakdown } from './cabinet-report';
import { sendTelegramMessage } from './telegram-notifier';

const MSK_OFFSET_HOURS = 3;

export type CpoGuardConfig = {
  enabled: boolean;
  ratio: number;
  absMinRub: number;
  absCeilingRub: number;
  minProductOrders: number;
  minCabinetOrders: number;
  streakRequired: number;
  realertCooldownMs: number;
  activeStartHour: number;
  activeEndHour: number;
};

export type CpoBreach = {
  vendorCode: string;
  article: string;
  cpo: number;
  spend: number;
  phoneOrders: number;
  blendedCpo: number | null;
  ratio: number | null; // cpo / blendedCpo, when a blended CPO is available
  reasons: Array<'relative' | 'absolute'>;
};

function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function parseActiveHours(raw: string | undefined): [number, number] {
  // "10-23" → [10, 23]; end-exclusive. Falls back to all-day on bad input.
  const m = (raw || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return [0, 24];
  const start = Math.min(23, Math.max(0, Number(m[1])));
  const end = Math.min(24, Math.max(0, Number(m[2])));
  return end > start ? [start, end] : [0, 24];
}

export function getConfigFromEnv(): CpoGuardConfig {
  const [activeStartHour, activeEndHour] = parseActiveHours(process.env.CPO_GUARD_ACTIVE_HOURS ?? '10-23');
  return {
    enabled: (process.env.CPO_GUARD_ENABLED ?? 'true').toLowerCase() !== 'false',
    ratio: numEnv('CPO_GUARD_RATIO', 3),
    absMinRub: numEnv('CPO_GUARD_ABS_MIN_RUB', 150),
    absCeilingRub: numEnv('CPO_GUARD_ABS_CEILING_RUB', 0),
    minProductOrders: numEnv('CPO_GUARD_MIN_ORDERS', 3),
    minCabinetOrders: numEnv('CPO_GUARD_MIN_CABINET_ORDERS', 10),
    streakRequired: numEnv('CPO_GUARD_STREAK', 2),
    realertCooldownMs: numEnv('CPO_GUARD_REALERT_MIN', 120) * 60_000,
    activeStartHour,
    activeEndHour,
  };
}

/**
 * Pure threshold evaluation — given a cabinet's CPO breakdown, return the
 * products that breach the ceiling(s). No state, no I/O (unit-tested).
 */
export function evaluateCpoBreaches(b: CpoBreakdown, cfg: CpoGuardConfig): CpoBreach[] {
  const breaches: CpoBreach[] = [];
  const blended = b.totalCpo;
  const cabinetHasVolume =
    b.totalPhoneOrders >= cfg.minCabinetOrders && blended != null && blended > 0;

  for (const r of b.rows) {
    if (r.cpo == null) continue;
    if (r.phoneOrders < cfg.minProductOrders) continue;

    const reasons: Array<'relative' | 'absolute'> = [];
    if (cfg.absCeilingRub > 0 && r.cpo > cfg.absCeilingRub) reasons.push('absolute');

    let ratioVal: number | null = null;
    if (cabinetHasVolume && cfg.ratio > 0) {
      ratioVal = r.cpo / (blended as number);
      if (ratioVal >= cfg.ratio && r.cpo >= cfg.absMinRub) reasons.push('relative');
    }

    if (reasons.length > 0) {
      breaches.push({
        vendorCode: r.vendorCode,
        article: r.article,
        cpo: r.cpo,
        spend: r.spend,
        phoneOrders: r.phoneOrders,
        blendedCpo: blended,
        ratio: ratioVal,
        reasons,
      });
    }
  }
  return breaches;
}

function isGuardConfigured(cfg: CpoGuardConfig): boolean {
  return cfg.enabled && (cfg.ratio > 0 || cfg.absCeilingRub > 0);
}

function formatRubles(amount: number): string {
  return Math.round(amount).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽';
}

function formatAlert(
  cabinetName: string,
  stamp: string,
  breakdown: CpoBreakdown,
  breaches: CpoBreach[],
): string {
  const lines = [`⚠️ <b>CPO выше нормы</b> | ${cabinetName} | ${stamp} МСК`];
  for (const br of breaches) {
    const tags: string[] = [];
    if (br.ratio != null && br.reasons.includes('relative')) tags.push(`×${br.ratio.toFixed(1)} ср.`);
    if (br.reasons.includes('absolute')) tags.push('выше потолка');
    const tag = tags.length ? ` (${tags.join(', ')})` : '';
    lines.push(
      `<code>${br.vendorCode}</code>: CPO ${formatRubles(br.cpo)}${tag} | ` +
        `${formatRubles(br.spend)} / ${br.phoneOrders} шт`,
    );
  }
  if (breakdown.totalCpo != null) {
    lines.push(`<i>Среднее по кабинету: ${formatRubles(breakdown.totalCpo)}</i>`);
  }
  return lines.join('\n');
}

// Per-(cabinet, product) streak + last-alert state. In-memory: reset on restart.
type GuardState = { streak: number; lastAlertTs: number };
const stateByKey = new Map<string, GuardState>();

/** Test helper — clears streak/cooldown state. */
export function _resetGuardStateForTests(): void {
  stateByKey.clear();
}

let _disabledLogged = false;

/**
 * One guard pass over all active cabinets. Registered as the `cpo-guard`
 * scheduled task. Alerts at most once per product per cooldown, only after a
 * sustained breach, only during active hours.
 */
export async function runCpoGuard(): Promise<void> {
  const cfg = getConfigFromEnv();
  if (!isGuardConfigured(cfg)) {
    if (!_disabledLogged) {
      console.log('[cpo-guard] disabled (CPO_GUARD_ENABLED=false or no ceiling configured)');
      _disabledLogged = true;
    }
    return;
  }
  _disabledLogged = false;

  const nowMsk = dayjs().add(MSK_OFFSET_HOURS, 'hour');
  const hour = nowMsk.hour();
  if (hour < cfg.activeStartHour || hour >= cfg.activeEndHour) {
    return; // outside ad hours — CPO reads are noisy (spend leads orders)
  }

  const startSql = nowMsk.startOf('day').format('YYYY-MM-DD HH:mm:ss');
  const endSql = nowMsk.format('YYYY-MM-DD HH:mm:ss');
  const stamp = nowMsk.format('DD.MM HH:mm');
  const now = Date.now();

  const cabinets = await cabinetsRepo.getActiveCabinets();
  for (const cab of cabinets) {
    try {
      const breakdown = await computeCabinetCpo(cab.id, startSql, endSql);
      if (!breakdown) continue;

      const breaches = evaluateCpoBreaches(breakdown, cfg);
      const breachedKeys = new Set(breaches.map(b => `${cab.id}:${b.article}`));

      const toAlert: CpoBreach[] = [];
      for (const br of breaches) {
        const key = `${cab.id}:${br.article}`;
        const st = stateByKey.get(key) ?? { streak: 0, lastAlertTs: 0 };
        st.streak += 1;
        if (st.streak >= cfg.streakRequired && now - st.lastAlertTs >= cfg.realertCooldownMs) {
          toAlert.push(br);
          st.lastAlertTs = now;
        }
        stateByKey.set(key, st);
      }

      // Reset streak for this cabinet's products that are no longer breaching.
      for (const key of stateByKey.keys()) {
        if (key.startsWith(`${cab.id}:`) && !breachedKeys.has(key)) {
          const st = stateByKey.get(key)!;
          st.streak = 0;
        }
      }

      if (toAlert.length > 0) {
        await sendTelegramMessage(formatAlert(cab.name, stamp, breakdown, toAlert));
        console.log(`[cpo-guard] cabinet ${cab.id} (${cab.name}): alerted on ${toAlert.length} product(s)`);
      }
    } catch (error: any) {
      console.error(`[cpo-guard] failed for cabinet ${cab.id}: ${error.message}`);
    }
  }
}
