import React, { useEffect, useState } from 'react';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';
import { useToast } from '../../hooks/useToast';
import DateRangePicker from '../layout/DateRangePicker';

function formatNumber(num: number | null | undefined): string {
  if (num == null) return '-';
  return new Intl.NumberFormat('ru-RU').format(Math.round(num * 100) / 100);
}

export default function FinancialPage() {
  const { dateFrom, dateTo } = useDateRange();
  const { showToast } = useToast();
  const [pnl, setPnl] = useState<any[]>([]);
  const [selectedNmId, setSelectedNmId] = useState<number | null>(null);
  const [unitEconomics, setUnitEconomics] = useState<any>(null);
  const [costs, setCosts] = useState<any>({});
  const [editingCosts, setEditingCosts] = useState(false);

  async function loadPnL() {
    try {
      const data = await api<any[]>(`/financial/pnl?dateFrom=${dateFrom}&dateTo=${dateTo}`);
      setPnl(data);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  useEffect(() => { loadPnL(); }, [dateFrom, dateTo]);

  async function syncSales() {
    showToast('Синхронизация продаж...');
    try {
      const result = await api<any>('/sync/sales-report', {
        method: 'POST',
        body: JSON.stringify({ dateFrom, dateTo }),
      });
      showToast(`Синхронизировано: ${result.synced}`, 'success');
      loadPnL();
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function viewUnitEconomics(nmId: number) {
    setSelectedNmId(nmId);
    try {
      const [ue, c] = await Promise.all([
        api<any>(`/financial/unit-economics/${nmId}`),
        api<any>(`/products/${nmId}/costs`),
      ]);
      setUnitEconomics(ue);
      setCosts(c);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function saveCosts() {
    if (!selectedNmId) return;
    try {
      await api(`/products/${selectedNmId}/costs`, {
        method: 'POST',
        body: JSON.stringify({
          cost_price: parseFloat(costs.cost_price) || 0,
          logistics_cost: parseFloat(costs.logistics_cost) || 0,
          commission_pct: parseFloat(costs.commission_pct) || 0,
          storage_cost: parseFloat(costs.storage_cost) || 0,
          packaging_cost: parseFloat(costs.packaging_cost) || 0,
          additional_cost: parseFloat(costs.additional_cost) || 0,
        }),
      });
      showToast('Сохранено', 'success');
      setEditingCosts(false);
      viewUnitEconomics(selectedNmId);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  const totals = pnl.reduce((acc, p) => ({
    revenue: acc.revenue + (p.total_revenue || 0),
    commission: acc.commission + (p.total_wb_commission || 0),
    logistics: acc.logistics + (p.total_logistics || 0),
    profit: acc.profit + (p.estimated_profit || 0),
  }), { revenue: 0, commission: 0, logistics: 0, profit: 0 });

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Финансы / P&L</h2>
        <button onClick={syncSales} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700">
          Синхронизировать продажи
        </button>
      </div>

      <DateRangePicker onApply={loadPnL} />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-gradient-to-br from-green-500 to-green-700 text-white rounded-xl p-4">
          <p className="text-white/70 text-sm">Выручка</p>
          <p className="text-2xl font-bold">{formatNumber(totals.revenue)} р</p>
        </div>
        <div className="bg-gradient-to-br from-orange-500 to-orange-700 text-white rounded-xl p-4">
          <p className="text-white/70 text-sm">Комиссия WB</p>
          <p className="text-2xl font-bold">{formatNumber(totals.commission)} р</p>
        </div>
        <div className="bg-gradient-to-br from-blue-500 to-blue-700 text-white rounded-xl p-4">
          <p className="text-white/70 text-sm">Логистика</p>
          <p className="text-2xl font-bold">{formatNumber(totals.logistics)} р</p>
        </div>
        <div className={`bg-gradient-to-br ${totals.profit >= 0 ? 'from-emerald-500 to-emerald-700' : 'from-red-500 to-red-700'} text-white rounded-xl p-4`}>
          <p className="text-white/70 text-sm">Прибыль</p>
          <p className="text-2xl font-bold">{formatNumber(totals.profit)} р</p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Артикул</th>
              <th className="text-left p-3">Название</th>
              <th className="text-right p-3">Выручка</th>
              <th className="text-right p-3">Комиссия</th>
              <th className="text-right p-3">Логистика</th>
              <th className="text-right p-3">Кол-во</th>
              <th className="text-right p-3">Прибыль</th>
              <th className="text-right p-3">Действия</th>
            </tr>
          </thead>
          <tbody>
            {pnl.length === 0 ? (
              <tr><td colSpan={8} className="text-center p-4 text-gray-500">Нет данных. Синхронизируйте продажи.</td></tr>
            ) : pnl.map(p => (
              <tr key={p.nm_id} className="border-b hover:bg-gray-50">
                <td className="p-3">{p.nm_id}</td>
                <td className="p-3">{p.name || '-'}</td>
                <td className="p-3 text-right">{formatNumber(p.total_revenue)}</td>
                <td className="p-3 text-right">{formatNumber(p.total_wb_commission)}</td>
                <td className="p-3 text-right">{formatNumber(p.total_logistics)}</td>
                <td className="p-3 text-right">{p.total_quantity}</td>
                <td className={`p-3 text-right font-medium ${p.estimated_profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatNumber(p.estimated_profit)}
                </td>
                <td className="p-3 text-right">
                  <button onClick={() => viewUnitEconomics(p.nm_id)} className="text-purple-600 hover:underline text-sm">Unit-экономика</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedNmId && unitEconomics && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Unit-экономика: {unitEconomics.name} ({selectedNmId})</h3>
            <button onClick={() => setEditingCosts(!editingCosts)} className="px-3 py-1 bg-gray-200 rounded text-sm hover:bg-gray-300">
              {editingCosts ? 'Отмена' : 'Редактировать затраты'}
            </button>
          </div>

          {editingCosts ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
              {[
                { key: 'cost_price', label: 'Себестоимость' },
                { key: 'logistics_cost', label: 'Логистика' },
                { key: 'commission_pct', label: 'Комиссия, %' },
                { key: 'storage_cost', label: 'Хранение' },
                { key: 'packaging_cost', label: 'Упаковка' },
                { key: 'additional_cost', label: 'Доп. расходы' },
              ].map(field => (
                <div key={field.key}>
                  <label className="block text-sm text-gray-600 mb-1">{field.label}</label>
                  <input
                    type="number"
                    value={costs[field.key] || ''}
                    onChange={e => setCosts({ ...costs, [field.key]: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
              ))}
              <div className="col-span-full">
                <button onClick={saveCosts} className="px-4 py-2 bg-purple-600 text-white rounded text-sm hover:bg-purple-700">Сохранить</button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Выручка/шт', value: unitEconomics.revenue_per_unit },
                { label: 'Себестоимость', value: unitEconomics.cost_price },
                { label: 'Комиссия WB', value: unitEconomics.wb_commission },
                { label: 'Логистика', value: unitEconomics.logistics },
                { label: 'Хранение', value: unitEconomics.storage },
                { label: 'Упаковка', value: unitEconomics.packaging },
                { label: 'Итого затраты', value: unitEconomics.total_cost },
                { label: 'Прибыль/шт', value: unitEconomics.profit_per_unit, highlight: true },
                { label: 'Маржа', value: unitEconomics.margin_pct, suffix: '%' },
                { label: 'ROI', value: unitEconomics.roi_pct, suffix: '%' },
              ].map((item, i) => (
                <div key={i} className={`p-3 rounded-lg ${item.highlight ? (unitEconomics.profit_per_unit >= 0 ? 'bg-green-50' : 'bg-red-50') : 'bg-gray-50'}`}>
                  <p className="text-xs text-gray-500">{item.label}</p>
                  <p className={`text-lg font-bold ${item.highlight ? (unitEconomics.profit_per_unit >= 0 ? 'text-green-600' : 'text-red-600') : ''}`}>
                    {formatNumber(item.value)}{item.suffix || ' р'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
