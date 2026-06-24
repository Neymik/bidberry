/**
 * Storage for warehouse penalties & dimension re-measurements pulled from WB's
 * financial detail report (reportDetailByPeriod).
 *
 * One row per WB report line that is a penalty (`penalty != 0`) or a габарит /
 * перемер adjustment. Dedup key is (cabinet_id, rrd_id) — WB's `rrd_id` is the
 * unique id of a settlement-report line, so re-running the sync never
 * double-counts. Full line-level history is kept here for later analysis /
 * dashboards.
 *
 * Alerting works at the GROUP level, not the line level: WB charges things like
 * "Занижение фактических габаритов упаковки товара" once per shipped unit, so a
 * single problem produces hundreds of lines. The alerter notifies once per
 * (product × reason) group the first time that group ever appears — see
 * getExistingGroupKeys(). That's the "a new charge appeared" signal; ongoing
 * accrual of an already-known group accumulates silently in this table.
 *
 * Schema is also declared in docker/init.sql for fresh installs; ensureSchema()
 * is the idempotent bootstrap for existing databases (mirrors the dev_tasks pattern).
 */

import dayjs from 'dayjs';
import { execute, query } from './connection';

export interface PenaltyRow {
  cabinetId: number;
  rrdId: number;
  nmId: number | null;
  saName: string | null;
  subjectName: string | null;
  bonusTypeName: string | null;
  supplierOperName: string | null;
  penalty: number;
  rrDt: string | null; // YYYY-MM-DD (report line date)
  kind: 'penalty' | 'dimension';
}

/** Identity of a "problem": one product + one charge reason. */
export function groupKey(r: Pick<PenaltyRow, 'saName' | 'nmId' | 'bonusTypeName' | 'supplierOperName'>): string {
  const product = r.saName || (r.nmId != null ? `nm:${r.nmId}` : '—');
  const reason = (r.bonusTypeName || r.supplierOperName || '').trim();
  return `${product}||${reason}`;
}

export async function ensureSchema(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS warehouse_penalties (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cabinet_id INT NOT NULL,
      rrd_id BIGINT NOT NULL,
      nm_id BIGINT,
      sa_name VARCHAR(255),
      subject_name VARCHAR(255),
      bonus_type_name VARCHAR(500),
      supplier_oper_name VARCHAR(500),
      penalty DECIMAL(15,2) NOT NULL DEFAULT 0,
      rr_dt DATE,
      kind VARCHAR(20) NOT NULL DEFAULT 'penalty',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_cabinet_rrd (cabinet_id, rrd_id),
      INDEX idx_cabinet_product (cabinet_id, sa_name),
      INDEX idx_rr_dt (rr_dt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/**
 * The set of group keys (product||reason) that ALREADY have at least one stored
 * line for this cabinet. Computed before inserting the current batch so the
 * caller can tell which groups are appearing for the first time.
 */
export async function getExistingGroupKeys(cabinetId: number): Promise<Set<string>> {
  const rows = await query<
    { sa_name: string | null; nm_id: number | null; bonus_type_name: string | null; supplier_oper_name: string | null }[]
  >(
    `SELECT DISTINCT sa_name, nm_id, bonus_type_name, supplier_oper_name
       FROM warehouse_penalties WHERE cabinet_id = ?`,
    [cabinetId]
  );
  const set = new Set<string>();
  for (const r of rows) {
    set.add(groupKey({ saName: r.sa_name, nmId: r.nm_id, bonusTypeName: r.bonus_type_name, supplierOperName: r.supplier_oper_name }));
  }
  return set;
}

export interface PenaltyGroupSummary {
  saName: string | null;
  nmId: number | null;
  subjectName: string | null;
  reason: string;
  kind: 'penalty' | 'dimension';
  total: number; // ₽ (can be negative — WB issues reversals)
  count: number; // report lines
  lastDate: string | null; // YYYY-MM-DD
}

export interface PenaltySummary {
  total: number;
  count: number;
  penaltyTotal: number;
  penaltyCount: number;
  dimensionTotal: number;
  dimensionCount: number;
}

/** Aggregate by (product × reason) for a cabinet over [dateFrom, dateTo]. */
export async function getPenaltyGroups(
  cabinetId: number,
  dateFrom: string,
  dateTo: string
): Promise<PenaltyGroupSummary[]> {
  const rows = await query<
    {
      sa_name: string | null;
      nm_id: number | null;
      subject_name: string | null;
      bonus_type_name: string | null;
      supplier_oper_name: string | null;
      kind: 'penalty' | 'dimension';
      total: string | number;
      cnt: number;
      last_date: string | Date | null;
    }[]
  >(
    `SELECT sa_name, nm_id, subject_name, bonus_type_name, supplier_oper_name, kind,
            SUM(penalty) AS total, COUNT(*) AS cnt, MAX(rr_dt) AS last_date
       FROM warehouse_penalties
      WHERE cabinet_id = ? AND rr_dt >= ? AND rr_dt <= ?
      GROUP BY sa_name, nm_id, subject_name, bonus_type_name, supplier_oper_name, kind
      ORDER BY ABS(SUM(penalty)) DESC, cnt DESC`,
    [cabinetId, dateFrom, dateTo]
  );
  return rows.map(r => ({
    saName: r.sa_name,
    nmId: r.nm_id != null ? Number(r.nm_id) : null,
    subjectName: r.subject_name,
    reason: (r.bonus_type_name || r.supplier_oper_name || '').trim(),
    kind: r.kind,
    total: Number(r.total),
    count: Number(r.cnt),
    lastDate: r.last_date ? dayjs(r.last_date).format('YYYY-MM-DD') : null,
  }));
}

/** Totals split by kind for a cabinet over [dateFrom, dateTo]. */
export async function getPenaltySummary(
  cabinetId: number,
  dateFrom: string,
  dateTo: string
): Promise<PenaltySummary> {
  const rows = await query<{ kind: 'penalty' | 'dimension'; total: string | number; cnt: number }[]>(
    `SELECT kind, SUM(penalty) AS total, COUNT(*) AS cnt
       FROM warehouse_penalties
      WHERE cabinet_id = ? AND rr_dt >= ? AND rr_dt <= ?
      GROUP BY kind`,
    [cabinetId, dateFrom, dateTo]
  );
  const summary: PenaltySummary = {
    total: 0,
    count: 0,
    penaltyTotal: 0,
    penaltyCount: 0,
    dimensionTotal: 0,
    dimensionCount: 0,
  };
  for (const r of rows) {
    const total = Number(r.total);
    const cnt = Number(r.cnt);
    summary.total += total;
    summary.count += cnt;
    if (r.kind === 'dimension') {
      summary.dimensionTotal += total;
      summary.dimensionCount += cnt;
    } else {
      summary.penaltyTotal += total;
      summary.penaltyCount += cnt;
    }
  }
  return summary;
}

/**
 * Store report lines, skipping any (cabinet_id, rrd_id) already present.
 * Idempotent — safe to call every cycle with the full lookback window.
 * Returns how many lines were newly inserted (for logging).
 */
export async function insertPenalties(rows: PenaltyRow[]): Promise<number> {
  let inserted = 0;
  for (const r of rows) {
    const res = await execute(
      `INSERT IGNORE INTO warehouse_penalties
        (cabinet_id, rrd_id, nm_id, sa_name, subject_name, bonus_type_name,
         supplier_oper_name, penalty, rr_dt, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.cabinetId,
        r.rrdId,
        r.nmId,
        r.saName,
        r.subjectName,
        r.bonusTypeName,
        r.supplierOperName,
        r.penalty,
        r.rrDt,
        r.kind,
      ]
    );
    if (res?.affectedRows) inserted += res.affectedRows;
  }
  return inserted;
}
