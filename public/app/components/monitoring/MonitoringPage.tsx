import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';

interface Campaign {
  id: number;
  name: string;
  status: string;
}

interface MonitoringProduct {
  nmId: number;
  vendorCode: string;
  name: string;
  campaigns: Campaign[];
  campaignsTotal: number;
  spendHourly: number;
  spendDaily: number;
  ordersHourly: number;
  ordersDaily: number;
  ordersRaw: number;
  buyoutPct: number;
  orderScalePct: number | null;
  orderScaleAuto: number;
  cpsHourly: number | null;
  cpsDaily: number | null;
  cpoHourly: number | null;
  cpoDaily: number | null;
  plannedBudgetDaily: number | null;
}

interface ChartPoint {
  time: string;
  spend: number;
  orders: number;
  cps: number | null;
  cpo: number | null;
}

interface SyncStatus {
  lastSyncAt: string | null;
  status: string;
  recordsSynced: number;
}

function formatRub(n: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

function timeSince(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  return `${hours} ч назад`;
}

function syncStatusColor(dateStr: string | null): string {
  if (!dateStr) return 'bg-gray-400';
  const min = (Date.now() - new Date(dateStr).getTime()) / 60000;
  if (min < 20) return 'bg-green-500';
  if (min < 60) return 'bg-yellow-500';
  return 'bg-red-500';
}

export default function MonitoringPage() {
  const { dateFrom, dateTo } = useDateRange();
  const [products, setProducts] = useState<MonitoringProduct[]>([]);
  const [balance, setBalance] = useState({ balance: 0, bonus: 0 });
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expandedNmId, setExpandedNmId] = useState<number | null>(null);
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
  const [chartPeriod, setChartPeriod] = useState<'hourly' | 'daily'>('daily');
  const [detailView, setDetailView] = useState<'chart' | 'table'>('chart');
  const [editingBuyout, setEditingBuyout] = useState<{ nmId: number; value: string } | null>(null);
  const [editingScale, setEditingScale] = useState<{ nmId: number; value: string } | null>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<any>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [data, status] = await Promise.all([
        api<{ products: MonitoringProduct[]; balance: { balance: number; bonus: number } }>(
          `/monitoring/products?dateFrom=${dateFrom}&dateTo=${dateTo}`
        ),
        api<SyncStatus>('/monitoring/sync-status'),
      ]);
      setProducts(data.products);
      setBalance(data.balance);
      setSyncStatus(status);
    } catch (e: any) {
      console.error('Monitoring load error:', e.message);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => { loadData(); }, [loadData]);

  // Trigger fast orders sync on page open (fire-and-forget)
  useEffect(() => {
    api('/sync/orders-fast', { method: 'POST' }).catch(() => {});
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await api<SyncStatus>('/monitoring/sync-status');
        setSyncStatus(status);
      } catch {}
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!expandedNmId) return;
    (async () => {
      try {
        const data = await api<{ points: ChartPoint[] }>(
          `/monitoring/products/${expandedNmId}/chart?period=${chartPeriod}&dateFrom=${dateFrom}&dateTo=${dateTo}`
        );
        setChartPoints(data.points);
      } catch (e: any) {
        console.error('Chart load error:', e.message);
      }
    })();
  }, [expandedNmId, chartPeriod, dateFrom, dateTo]);

  // Render chart
  useEffect(() => {
    if (detailView !== 'chart' || !chartRef.current || chartPoints.length === 0) return;
    import('https://cdn.jsdelivr.net/npm/chart.js/+esm').then((ChartModule: any) => {
      const Chart = ChartModule.Chart || ChartModule.default?.Chart;
      const components = ChartModule.registerables || ChartModule.default?.registerables;
      if (components) Chart.register(...components);
      if (chartInstance.current) chartInstance.current.destroy();

      chartInstance.current = new Chart(chartRef.current, {
        type: 'line',
        data: {
          labels: chartPoints.map(p => p.time),
          datasets: [
            {
              label: 'Расход (₽)',
              data: chartPoints.map(p => p.spend),
              borderColor: '#6366f1',
              backgroundColor: 'rgba(99,102,241,0.1)',
              yAxisID: 'y',
              tension: 0.3,
            },
            {
              label: 'Заказы',
              data: chartPoints.map(p => p.orders),
              borderColor: '#22c55e',
              backgroundColor: 'rgba(34,197,94,0.1)',
              yAxisID: 'y1',
              tension: 0.3,
            },
            {
              label: 'CPS (₽)',
              data: chartPoints.map(p => p.cps),
              borderColor: '#ef4444',
              backgroundColor: 'rgba(239,68,68,0.1)',
              yAxisID: 'y',
              tension: 0.3,
            },
            {
              label: 'CPO (₽)',
              data: chartPoints.map(p => p.cpo),
              borderColor: '#f59e0b',
              backgroundColor: 'rgba(245,158,11,0.1)',
              yAxisID: 'y',
              tension: 0.3,
              borderDash: [5, 5],
            },
          ],
        },
        options: {
          responsive: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            y: { type: 'linear', position: 'left', title: { display: true, text: '₽' } },
            y1: { type: 'linear', position: 'right', title: { display: true, text: 'Заказы' }, grid: { drawOnChartArea: false } },
          },
        },
      });
    });
    return () => { if (chartInstance.current) chartInstance.current.destroy(); };
  }, [chartPoints, detailView]);

  async function handleSync() {
    setSyncing(true);
    try {
      const result = await api<{ success: boolean; synced: number; error?: string }>('/sync/financial', { method: 'POST' });
      if (result.error) {
        alert(`Ошибка синхронизации: ${result.error}\n\nПроверьте логи сервера для получения подробной информации.`);
      } else {
        alert(`Синхронизация завершена! Обновлено записей: ${result.synced}`);
      }
      await loadData();
    } catch (e: any) {
      const errorMsg = e.message || 'Неизвестная ошибка при синхронизации';
      if (errorMsg.includes('429') || errorMsg.toLowerCase().includes('too many requests')) {
        alert('Синхронизация уже выполняется. Попробуйте через 5 минут.');
      } else if (errorMsg.includes('500') || errorMsg.toLowerCase().includes('internal server error')) {
        alert(`Ошибка сервера Wildberries API. Подробности:\n${errorMsg}\n\nПроверьте консоль браузера и логи сервера.`);
      } else {
        alert(`Ошибка: ${errorMsg}`);
      }
    } finally {
      setSyncing(false);
    }
  }

  async function saveBuyout(nmId: number, value: string) {
    const pct = parseFloat(value);
    if (isNaN(pct) || pct <= 0 || pct > 100) return;
    try {
      await api(`/monitoring/products/${nmId}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ buyoutPct: pct }),
      });
      setProducts(prev => prev.map(p => p.nmId === nmId ? { ...p, buyoutPct: pct } : p));
    } catch (e: any) {
      console.error('Save buyout error:', e.message);
    }
    setEditingBuyout(null);
  }

  async function saveScale(nmId: number, value: string | null) {
    const pct = value === null ? null : parseFloat(value);
    if (pct !== null && (isNaN(pct) || pct < 100 || pct > 300)) return;
    try {
      await api(`/monitoring/products/${nmId}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ orderScalePct: pct }),
      });
      setProducts(prev => prev.map(p =>
        p.nmId === nmId ? { ...p, orderScalePct: pct } : p
      ));
    } catch (e: any) {
      console.error('Save scale error:', e.message);
    }
    setEditingScale(null);
  }

  // Auto-refresh every 2 minutes
  useEffect(() => {
    const interval = setInterval(() => { loadData(); }, 120_000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Загрузка...</div>;
  }

  const colSpan = 13;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold text-gray-900">Мониторинг заказов CPS</h1>
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-600">
            Баланс: <span className="font-semibold text-gray-900">{formatRub(balance.balance)} ₽</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${syncStatusColor(syncStatus?.lastSyncAt ?? null)}`} />
            <span className="text-sm text-gray-500">
              {syncStatus?.lastSyncAt ? timeSince(syncStatus.lastSyncAt) : 'Нет данных'}
            </span>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-50"
          >
            {syncing ? 'Синхронизация...' : 'Обновить'}
          </button>
        </div>
      </div>

      {/* Products table */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Артикул WB</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Артикул</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Товар</th>
              <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">Кампании</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Расход/час</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Расход/день</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Заказы/час</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">Заказы/день</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase" title="Коэффициент масштабирования заказов. WB API отдаёт ~80-85% реальных заказов. Авто = рассчитан из Analytics API. Нажмите чтобы задать вручную.">Коэфф.</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">% выкупа</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">CPO/день</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">CPS/час</th>
              <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">CPS/день</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {products.map(p => (
              <React.Fragment key={p.nmId}>
                <tr
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedNmId(expandedNmId === p.nmId ? null : p.nmId)}
                >
                  <td className="px-3 py-3 text-sm font-mono text-gray-700">{p.nmId}</td>
                  <td className="px-3 py-3 text-sm font-mono text-gray-500">{p.vendorCode || '—'}</td>
                  <td className="px-3 py-3 text-sm text-gray-900 max-w-[180px] truncate">{p.name}</td>
                  <td className="px-3 py-3 text-sm text-gray-600 max-w-[150px] truncate">
                    {p.campaigns.map(c => c.name || `#${c.id}`).join(', ')}
                    {p.campaignsTotal > 2 && <span className="text-xs text-gray-400"> +{p.campaignsTotal - 2}</span>}
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-700">{formatRub(p.spendHourly)} ₽</td>
                  <td className={`px-3 py-3 text-sm text-right font-medium ${
                    p.plannedBudgetDaily && p.spendDaily > p.plannedBudgetDaily ? 'text-red-600' : 'text-gray-700'
                  }`}>
                    {formatRub(p.spendDaily)} ₽
                  </td>
                  <td className="px-3 py-3 text-sm text-right text-gray-700">{p.ordersHourly}</td>
                  <td className="px-3 py-3 text-sm text-right text-gray-700">
                    {p.ordersDaily}
                    {p.ordersRaw !== p.ordersDaily && (
                      <span className="text-xs text-gray-400 ml-1" title="Сырые данные из WB Statistics API">(из {p.ordersRaw})</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-sm text-right" onClick={e => e.stopPropagation()}>
                    {editingScale?.nmId === p.nmId ? (
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          className="w-16 px-1 py-0.5 text-sm border rounded text-right"
                          value={editingScale.value}
                          onChange={e => setEditingScale({ nmId: p.nmId, value: e.target.value })}
                          onBlur={() => saveScale(p.nmId, editingScale.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') saveScale(p.nmId, editingScale.value);
                            if (e.key === 'Escape') setEditingScale(null);
                          }}
                          autoFocus
                          min={100}
                          max={300}
                        />
                        <button
                          className="text-xs text-gray-400 hover:text-purple-600"
                          title="Сбросить на авто"
                          onClick={() => saveScale(p.nmId, null)}
                        >↺</button>
                      </div>
                    ) : (
                      <span
                        className={`cursor-pointer hover:text-purple-600 ${p.orderScalePct != null ? 'text-purple-700 font-medium' : 'text-gray-400'}`}
                        title={p.orderScalePct != null
                          ? `Ручная установка. Авто: ${p.orderScaleAuto}%. Нажмите для изменения, ↺ для сброса`
                          : `Авто-расчёт из Analytics API. Нажмите чтобы задать вручную`}
                        onClick={() => setEditingScale({
                          nmId: p.nmId,
                          value: String(p.orderScalePct ?? p.orderScaleAuto)
                        })}
                      >
                        {p.orderScalePct != null ? `${p.orderScalePct}%` : `${p.orderScaleAuto}%`}
                        {p.orderScalePct == null && <span className="text-xs ml-0.5">авто</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-sm text-right" onClick={e => e.stopPropagation()}>
                    {editingBuyout?.nmId === p.nmId ? (
                      <input
                        type="number"
                        className="w-16 px-1 py-0.5 text-sm border rounded text-right"
                        value={editingBuyout.value}
                        onChange={e => setEditingBuyout({ nmId: p.nmId, value: e.target.value })}
                        onBlur={() => saveBuyout(p.nmId, editingBuyout.value)}
                        onKeyDown={e => e.key === 'Enter' && saveBuyout(p.nmId, editingBuyout.value)}
                        autoFocus
                        min={1}
                        max={100}
                      />
                    ) : (
                      <span
                        className="cursor-pointer hover:text-purple-600"
                        onClick={() => setEditingBuyout({ nmId: p.nmId, value: String(p.buyoutPct) })}
                      >
                        {p.buyoutPct}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-sm text-right font-medium">
                    {p.cpoDaily !== null ? (
                      <span className="text-amber-600">{formatRub(p.cpoDaily)} ₽</span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-right font-medium">
                    {p.cpsHourly !== null ? (
                      <span className={p.cpsHourly > 500 ? 'text-red-600' : 'text-green-600'}>
                        {formatRub(p.cpsHourly)} ₽
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-3 text-sm text-right font-medium">
                    {p.cpsDaily !== null ? (
                      <span className={p.cpsDaily > 500 ? 'text-red-600' : 'text-green-600'}>
                        {formatRub(p.cpsDaily)} ₽
                      </span>
                    ) : '—'}
                  </td>
                </tr>

                {/* Expandable detail row */}
                {expandedNmId === p.nmId && (
                  <tr>
                    <td colSpan={colSpan} className="px-4 py-4 bg-gray-50">
                      <div className="flex items-center gap-2 mb-4">
                        <span className="text-sm font-medium text-gray-700">Период:</span>
                        <button
                          className={`px-3 py-1 text-xs rounded ${chartPeriod === 'hourly' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
                          onClick={() => setChartPeriod('hourly')}
                        >
                          По часам
                        </button>
                        <button
                          className={`px-3 py-1 text-xs rounded ${chartPeriod === 'daily' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
                          onClick={() => setChartPeriod('daily')}
                        >
                          По дням
                        </button>

                        <span className="mx-2 text-gray-300">|</span>

                        <span className="text-sm font-medium text-gray-700">Вид:</span>
                        <button
                          className={`px-3 py-1 text-xs rounded ${detailView === 'chart' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
                          onClick={() => setDetailView('chart')}
                        >
                          График
                        </button>
                        <button
                          className={`px-3 py-1 text-xs rounded ${detailView === 'table' ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700'}`}
                          onClick={() => setDetailView('table')}
                        >
                          Таблица
                        </button>
                      </div>

                      {detailView === 'chart' ? (
                        <div className="h-72">
                          <canvas ref={chartRef} />
                        </div>
                      ) : (
                        <div className="max-h-96 overflow-y-auto">
                          <table className="min-w-full text-sm">
                            <thead className="bg-gray-100 sticky top-0">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium text-gray-600">{chartPeriod === 'hourly' ? 'Час' : 'Дата'}</th>
                                <th className="px-3 py-2 text-right font-medium text-gray-600">Расход ₽</th>
                                <th className="px-3 py-2 text-right font-medium text-gray-600">Заказы</th>
                                <th className="px-3 py-2 text-right font-medium text-gray-600">CPO ₽</th>
                                <th className="px-3 py-2 text-right font-medium text-gray-600">CPS ₽</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {chartPoints.map((pt, i) => (
                                <tr key={i} className="hover:bg-gray-50">
                                  <td className="px-3 py-1.5 font-mono text-gray-700">{pt.time}</td>
                                  <td className="px-3 py-1.5 text-right text-gray-700">{formatRub(pt.spend)}</td>
                                  <td className="px-3 py-1.5 text-right text-gray-700">{pt.orders}</td>
                                  <td className="px-3 py-1.5 text-right font-medium text-amber-600">
                                    {pt.cpo !== null ? formatRub(pt.cpo) : '—'}
                                  </td>
                                  <td className={`px-3 py-1.5 text-right font-medium ${
                                    pt.cps !== null && pt.cps > 500 ? 'text-red-600' : 'text-green-600'
                                  }`}>
                                    {pt.cps !== null ? formatRub(pt.cps) : '—'}
                                  </td>
                                </tr>
                              ))}
                              {chartPoints.length > 0 && (
                                <tr className="bg-gray-100 font-semibold">
                                  <td className="px-3 py-2 text-gray-800">Итого</td>
                                  <td className="px-3 py-2 text-right text-gray-800">
                                    {formatRub(chartPoints.reduce((s, p) => s + p.spend, 0))}
                                  </td>
                                  <td className="px-3 py-2 text-right text-gray-800">
                                    {chartPoints.reduce((s, p) => s + p.orders, 0)}
                                  </td>
                                  <td className="px-3 py-2 text-right text-amber-700">
                                    {(() => {
                                      const ts = chartPoints.reduce((s, p) => s + p.spend, 0);
                                      const to = chartPoints.reduce((s, p) => s + p.orders, 0);
                                      return to > 0 ? formatRub(ts / to) : '—';
                                    })()}
                                  </td>
                                  <td className="px-3 py-2 text-right text-green-700">
                                    {(() => {
                                      const ts = chartPoints.reduce((s, p) => s + p.spend, 0);
                                      const to = chartPoints.reduce((s, p) => s + p.orders, 0);
                                      return to > 0 && p.buyoutPct > 0 ? formatRub(ts / (to * p.buyoutPct / 100)) : '—';
                                    })()}
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {chartPoints.length === 0 && (
                        <div className="text-center text-gray-400 text-sm mt-4">Нет данных за выбранный период</div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="px-4 py-8 text-center text-gray-400">
                  Нет товаров с привязанными рекламными кампаниями
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
