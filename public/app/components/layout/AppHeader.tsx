import React, { useEffect, useState } from 'react';
import { api } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../hooks/useAuth';
import { useCabinet } from '../../hooks/useCabinet';

function formatNumber(num: number | null | undefined): string {
  if (num == null) return '-';
  return new Intl.NumberFormat('ru-RU').format(Math.round(num * 100) / 100);
}

export default function AppHeader() {
  const [status, setStatus] = useState<string>('Проверка...');
  const [statusClass, setStatusClass] = useState('bg-gray-200');
  const [balance, setBalance] = useState<string>('');
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState('');
  const { showToast } = useToast();
  const { user, logout } = useAuth();
  const { cabinets, selectedCabinetId, selectCabinet } = useCabinet();

  useEffect(() => {
    checkHealth();
  }, [selectedCabinetId]);

  async function checkHealth() {
    try {
      const health = await api<any>('/health');
      const dbOk = health.services.database === 'connected';
      const wbOk = health.services.wildberries === 'connected';
      if (dbOk && wbOk) {
        setStatus('Подключено');
        setStatusClass('bg-green-100 text-green-800');
      } else if (dbOk) {
        setStatus('БД OK, WB ошибка');
        setStatusClass('bg-yellow-100 text-yellow-800');
      } else {
        setStatus('Ошибка подключения');
        setStatusClass('bg-red-100 text-red-800');
      }
      if (wbOk) {
        const bal = await api<any>('/wb/balance');
        setBalance(`Баланс: ${formatNumber(bal.balance)} р (бонус: ${formatNumber(bal.bonus)} р)`);
      }
    } catch {
      setStatus('Ошибка');
      setStatusClass('bg-red-100 text-red-800');
    }
  }

  async function syncAll() {
    if (syncing) return;
    setSyncing(true);

    const now = new Date();
    const dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateTo = now.toISOString().slice(0, 10);

    const steps = [
      { label: 'Кампании', fn: () => api('/sync/campaigns', { method: 'POST' }) },
      { label: 'Товары', fn: () => api('/sync/products', { method: 'POST' }) },
      { label: 'Статистика РК', fn: () => api('/sync/stats', { method: 'POST', body: JSON.stringify({ dateFrom, dateTo }) }) },
      { label: 'Аналитика товаров', fn: () => api('/sync/product-analytics', { method: 'POST', body: JSON.stringify({ dateFrom, dateTo }) }) },
      { label: 'Источники трафика', fn: () => api('/sync/traffic-sources', { method: 'POST', body: JSON.stringify({ dateFrom, dateTo }) }) },
      { label: 'Заказы', fn: () => api('/sync/orders', { method: 'POST', body: JSON.stringify({ dateFrom }) }) },
      { label: 'Остатки', fn: () => api('/sync/stocks', { method: 'POST' }) },
      { label: 'Отчёт по продажам', fn: () => api('/sync/sales-report', { method: 'POST', body: JSON.stringify({ dateFrom, dateTo }) }) },
    ];

    let completed = 0;
    let errors: string[] = [];

    for (const step of steps) {
      completed++;
      setSyncProgress(`${step.label} (${completed}/${steps.length})`);
      try {
        await step.fn();
      } catch (e: any) {
        errors.push(`${step.label}: ${e.message}`);
      }
    }

    setSyncing(false);
    setSyncProgress('');

    if (errors.length === 0) {
      showToast('Синхронизация завершена', 'success');
    } else {
      showToast(`Завершено с ошибками (${errors.length}): ${errors[0]}`, 'error');
    }
  }

  return (
    <header className="bg-white shadow-sm border-b sticky top-0 z-50">
      <div className="max-w-full mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-bold text-purple-600">WB Analytics</h1>
          {cabinets.length > 1 && (
            <select
              value={selectedCabinetId || ''}
              onChange={(e) => selectCabinet(parseInt(e.target.value))}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            >
              {cabinets.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          {cabinets.length === 1 && (
            <span className="text-sm text-gray-500">{cabinets[0].name}</span>
          )}
          <span className={`text-xs px-3 py-1 rounded-full ${statusClass}`}>{status}</span>
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-sm text-gray-600">{balance}</span>
          <button
            onClick={syncAll}
            disabled={syncing}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${syncing ? 'bg-purple-400 cursor-wait' : 'bg-purple-600 hover:bg-purple-700'} text-white`}
          >
            {syncing ? `Синхронизация: ${syncProgress}` : 'Синхронизировать'}
          </button>
          {user && (
            <div className="flex items-center space-x-3 border-l pl-4 ml-2">
              <span className="text-sm text-gray-600">{user.first_name || user.username || 'User'}</span>
              <button onClick={logout} className="text-sm text-gray-400 hover:text-red-500">Выход</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
