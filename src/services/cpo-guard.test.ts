import { describe, it, expect } from 'bun:test';
import {
  evaluateCpoBreaches,
  getConfigFromEnv,
  type CpoGuardConfig,
} from './cpo-guard';
import type { CpoBreakdown, CpoRow } from './cabinet-report';

const baseCfg: CpoGuardConfig = {
  enabled: true,
  ratio: 3,
  absMinRub: 150,
  absCeilingRub: 0,
  minProductOrders: 3,
  minCabinetOrders: 10,
  streakRequired: 2,
  realertCooldownMs: 120 * 60_000,
  activeStartHour: 10,
  activeEndHour: 23,
};

function row(p: Partial<CpoRow>): CpoRow {
  return {
    vendorCode: 'V',
    article: '100',
    phoneOrders: 10,
    apiOrders: 8,
    spend: 0,
    cpo: 0,
    ...p,
  };
}

function breakdown(rows: CpoRow[]): CpoBreakdown {
  const totalPhoneOrders = rows.reduce((s, r) => s + r.phoneOrders, 0);
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  return {
    rows,
    totalPhoneOrders,
    totalApiOrders: rows.reduce((s, r) => s + r.apiOrders, 0),
    totalSpend,
    totalCpo: totalPhoneOrders > 0 ? Math.round(totalSpend / totalPhoneOrders) : null,
    startSql: '2026-06-23 00:00:00',
    endSql: '2026-06-23 12:00:00',
  };
}

describe('evaluateCpoBreaches', () => {
  it('flags a product whose CPO is >= ratio × blended CPO', () => {
    // blended = (100*10 + 1000*5) / 15 = 400; product B cpo 1000 = 2.5× -> below 3×
    // make it clearer: A cheap, B expensive
    const b = breakdown([
      row({ article: 'A', vendorCode: 'A', phoneOrders: 30, spend: 3000, cpo: 100 }),
      row({ article: 'B', vendorCode: 'B', phoneOrders: 5, spend: 2500, cpo: 500 }),
    ]);
    // blended = 5500/35 ≈ 157; B 500 / 157 ≈ 3.18 ≥ 3 and ≥150 -> breach
    const breaches = evaluateCpoBreaches(b, baseCfg);
    expect(breaches.map(x => x.article)).toEqual(['B']);
    expect(breaches[0]!.reasons).toContain('relative');
    expect(breaches[0]!.ratio).toBeGreaterThanOrEqual(3);
  });

  it('does not flag when CPO is only modestly above average', () => {
    const b = breakdown([
      row({ article: 'A', phoneOrders: 30, spend: 3000, cpo: 100 }),
      row({ article: 'B', phoneOrders: 10, spend: 2000, cpo: 200 }), // ~1.4× blended
    ]);
    expect(evaluateCpoBreaches(b, baseCfg)).toHaveLength(0);
  });

  it('respects the absolute floor under the relative rule', () => {
    // blended tiny: A cpo 10, B cpo 60 = 6× but 60 < absMin 150 -> no relative
    const b = breakdown([
      row({ article: 'A', phoneOrders: 50, spend: 500, cpo: 10 }),
      row({ article: 'B', phoneOrders: 10, spend: 600, cpo: 60 }),
    ]);
    expect(evaluateCpoBreaches(b, baseCfg)).toHaveLength(0);
  });

  it('flags on the absolute ceiling regardless of ratio', () => {
    const cfg = { ...baseCfg, absCeilingRub: 300 };
    const b = breakdown([
      row({ article: 'A', phoneOrders: 30, spend: 12000, cpo: 400 }),
      row({ article: 'B', phoneOrders: 30, spend: 12000, cpo: 400 }),
    ]);
    // blended 400, ratio 1.0 (no relative), but 400 > 300 ceiling -> absolute
    const breaches = evaluateCpoBreaches(b, cfg);
    expect(breaches).toHaveLength(2);
    expect(breaches[0]!.reasons).toEqual(['absolute']);
  });

  it('skips products below the minimum order volume', () => {
    const b = breakdown([
      row({ article: 'A', phoneOrders: 30, spend: 3000, cpo: 100 }),
      row({ article: 'B', phoneOrders: 2, spend: 2000, cpo: 1000 }), // huge cpo but only 2 orders
    ]);
    expect(evaluateCpoBreaches(b, baseCfg)).toHaveLength(0);
  });

  it('suppresses the relative rule when the cabinet lacks order volume', () => {
    // cabinet has < minCabinetOrders total -> blended CPO not trusted
    const b = breakdown([
      row({ article: 'A', phoneOrders: 3, spend: 300, cpo: 100 }),
      row({ article: 'B', phoneOrders: 3, spend: 3000, cpo: 1000 }),
    ]);
    expect(evaluateCpoBreaches(b, baseCfg)).toHaveLength(0);
  });

  it('ignores rows with null CPO (no orders)', () => {
    const b = breakdown([
      row({ article: 'A', phoneOrders: 30, spend: 3000, cpo: 100 }),
      row({ article: 'B', phoneOrders: 0, spend: 0, cpo: null }),
    ]);
    expect(evaluateCpoBreaches(b, baseCfg)).toHaveLength(0);
  });
});

describe('getConfigFromEnv', () => {
  it('parses active-hours and applies defaults', () => {
    const saved = process.env.CPO_GUARD_ACTIVE_HOURS;
    process.env.CPO_GUARD_ACTIVE_HOURS = '9-22';
    const cfg = getConfigFromEnv();
    expect(cfg.activeStartHour).toBe(9);
    expect(cfg.activeEndHour).toBe(22);
    expect(cfg.ratio).toBe(3);
    expect(cfg.enabled).toBe(true);
    if (saved == null) delete process.env.CPO_GUARD_ACTIVE_HOURS;
    else process.env.CPO_GUARD_ACTIVE_HOURS = saved;
  });
});
