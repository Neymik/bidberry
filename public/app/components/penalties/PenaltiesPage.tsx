import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';
import { useCabinet } from '../../hooks/useCabinet';

interface PenaltyGroup {
  saName: string | null;
  nmId: number | null;
  subjectName: string | null;
  reason: string;
  kind: 'penalty' | 'dimension';
  total: number;
  count: number;
  lastDate: string | null;
}

interface PenaltySummary {
  total: number;
  count: number;
  penaltyTotal: number;
  penaltyCount: number;
  dimensionTotal: number;
  dimensionCount: number;
}

interface PenaltiesResponse {
  summary: PenaltySummary;
  groups: PenaltyGroup[];
  dateFrom: string;
  dateTo: string;
}

function formatRub(n: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₽';
}

type Filter = 'all' | 'penalty' | 'dimension';

export default function PenaltiesPage() {
  const { dateFrom, dateTo } = useDateRange();
  const { selectedCabinetId } = useCabinet();
  const [data, setData] = useState<PenaltiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api<PenaltiesResponse>(
        `/penalties?dateFrom=${dateFrom}&dateTo=${dateTo}`
      );
      setData(res);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, selectedCabinetId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const groups = (data?.groups || []).filter(g => filter === 'all' || g.kind === filter);
  const s = data?.summary;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Штрафы и габариты от склада</h1>
          <p className="text-sm text-gray-500 mt-1">
            Источник: финотчёт WB (еженедельный, с лагом). Обновляется задачей penalty-guard.
          </p>
        </div>
        <button
          onClick={loadData}
          className="px-3 py-2 text-sm bg-white border rounded-lg text-gray-700 hover:bg-gray-50"
        >
          Обновить
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs uppercase text-gray-500">Всего удержано</div>
          <div className="text-2xl font-bold text-red-600 mt-1">
            {s ? formatRub(s.total) : '—'}
          </div>
          <div className="text-xs text-gray-400 mt-1">{s ? `${s.count} строк` : ''}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs uppercase text-gray-500">Перемер габаритов</div>
          <div className="text-2xl font-bold text-orange-600 mt-1">
            {s ? formatRub(s.dimensionTotal) : '—'}
          </div>
          <div className="text-xs text-gray-400 mt-1">{s ? `${s.dimensionCount} строк` : ''}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs uppercase text-gray-500">Прочие штрафы</div>
          <div className="text-2xl font-bold text-gray-800 mt-1">
            {s ? formatRub(s.penaltyTotal) : '—'}
          </div>
          <div className="text-xs text-gray-400 mt-1">{s ? `${s.penaltyCount} строк` : ''}</div>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {([
          ['all', 'Все'],
          ['dimension', 'Габариты'],
          ['penalty', 'Штрафы'],
        ] as [Filter, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              filter === key
                ? 'bg-purple-50 text-purple-700 border-purple-300 font-medium'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-48 text-gray-500">Загрузка...</div>
      ) : error ? (
        <div className="p-6 bg-red-50 text-red-600 rounded-lg">Ошибка: {error}</div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Тип</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Артикул</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Артикул WB</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Предмет</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Причина</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Кол-во</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Сумма</th>
                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Последняя</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {groups.map((g, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-3 py-3 text-lg">{g.kind === 'dimension' ? '📦' : '⚠️'}</td>
                  <td className="px-3 py-3 text-sm font-mono text-gray-700">{g.saName || '—'}</td>
                  <td className="px-3 py-3 text-sm font-mono text-gray-500">{g.nmId ?? '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-900">{g.subjectName || '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-600">{g.reason || '—'}</td>
                  <td className="px-3 py-3 text-sm text-right text-gray-700">{g.count}</td>
                  <td
                    className={`px-3 py-3 text-sm text-right font-medium ${
                      g.total < 0 ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {formatRub(g.total)}
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-400">{g.lastDate || '—'}</td>
                </tr>
              ))}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-400">
                    Нет штрафов за выбранный период
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
