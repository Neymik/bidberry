import { describe, expect, it } from 'bun:test';
import { classifyReportRow, aggregateGroups, formatPenaltyAlert } from './penalty-guard';
import type { PenaltyRow } from '../db/penalty-repository';

describe('classifyReportRow', () => {
  const cab = 7;

  it('keeps lines with penalty != 0 as kind=penalty', () => {
    const row = classifyReportRow(
      { rrd_id: 101, penalty: 250, nm_id: 555, sa_name: 'ART-1', subject_name: 'Носки', bonus_type_name: 'Штраф за маркировку', rr_dt: '2026-06-10T00:00:00Z' },
      cab
    );
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('penalty');
    expect(row!.penalty).toBe(250);
    expect(row!.saName).toBe('ART-1');
    expect(row!.rrDt).toBe('2026-06-10');
  });

  it('keeps negative penalties (reversals)', () => {
    const row = classifyReportRow({ rrd_id: 105, penalty: -250, sa_name: 'ART-1' }, cab);
    expect(row).not.toBeNull();
    expect(row!.penalty).toBe(-250);
  });

  it('flags габарит lines as kind=dimension even with zero penalty', () => {
    const row = classifyReportRow(
      { rrd_id: 102, penalty: 0, sa_name: 'ART-2', supplier_oper_name: 'Изменение габаритов товара' },
      cab
    );
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('dimension');
  });

  it('detects the real WB reason "Занижение фактических габаритов упаковки товара"', () => {
    const row = classifyReportRow(
      { rrd_id: 103, penalty: 394.5, sa_name: 'X', bonus_type_name: 'Занижение фактических габаритов упаковки товара' },
      cab
    );
    expect(row!.kind).toBe('dimension');
  });

  it('drops ordinary lines (no penalty, no dimension)', () => {
    expect(classifyReportRow({ rrd_id: 104, penalty: 0, bonus_type_name: 'Продажа' }, cab)).toBeNull();
  });

  it('drops lines with invalid rrd_id', () => {
    expect(classifyReportRow({ penalty: 100 }, cab)).toBeNull();
    expect(classifyReportRow({ rrd_id: 0, penalty: 100 }, cab)).toBeNull();
  });
});

describe('aggregateGroups', () => {
  it('collapses many lines of one (product × reason) into one group with count+sum', () => {
    const rows: PenaltyRow[] = Array.from({ length: 3 }, (_, i) => ({
      cabinetId: 1, rrdId: i + 1, nmId: 10, saName: 'A', subjectName: null,
      bonusTypeName: 'Занижение габаритов', supplierOperName: null, penalty: 100, rrDt: '2026-06-10', kind: 'dimension',
    }));
    const groups = aggregateGroups(rows);
    expect(groups.size).toBe(1);
    const g = [...groups.values()][0];
    expect(g.count).toBe(3);
    expect(g.sum).toBe(300);
    expect(g.kind).toBe('dimension');
  });

  it('separates different reasons for the same product', () => {
    const rows: PenaltyRow[] = [
      { cabinetId: 1, rrdId: 1, nmId: 10, saName: 'A', subjectName: null, bonusTypeName: 'Габариты', supplierOperName: null, penalty: 100, rrDt: null, kind: 'dimension' },
      { cabinetId: 1, rrdId: 2, nmId: 10, saName: 'A', subjectName: null, bonusTypeName: 'Маркировка', supplierOperName: null, penalty: 50, rrDt: null, kind: 'penalty' },
    ];
    expect(aggregateGroups(rows).size).toBe(2);
  });
});

describe('formatPenaltyAlert', () => {
  const groups = [
    { key: 'A||Перемер габаритов', product: 'A', reason: 'Перемер габаритов', kind: 'dimension' as const, count: 1015, sum: 400000 },
    { key: 'B||Штраф', product: 'B', reason: 'Штраф', kind: 'penalty' as const, count: 2, sum: 300 },
  ];

  it('summarises problem count, dimension count and total; dimension first', () => {
    const msg = formatPenaltyAlert('Каб', groups, 40);
    expect(msg).toContain('Новых проблем: <b>2</b>');
    expect(msg).toContain('перемер габаритов: 1');
    expect(msg).toContain('1015 шт');
    expect(msg.indexOf('>A<')).toBeLessThan(msg.indexOf('>B<'));
  });

  it('truncates with an overflow note when over maxLines', () => {
    const msg = formatPenaltyAlert('Каб', groups, 1);
    expect(msg).toContain('…и ещё 1');
  });
});
