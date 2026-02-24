import React, { useEffect, useState } from 'react';
import { api } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../hooks/useAuth';

function formatNumber(num: number | null | undefined): string {
  if (num == null) return '-';
  return new Intl.NumberFormat('ru-RU').format(Math.round(num * 100) / 100);
}

export default function AppHeader() {
  const [status, setStatus] = useState<string>('Проверка...');
  const [statusClass, setStatusClass] = useState('bg-gray-200');
  const [balance, setBalance] = useState<string>('');
  const { showToast } = useToast();
  const { user, logout } = useAuth();

  useEffect(() => {
    checkHealth();
  }, []);

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
    showToast('Синхронизация...');
    try {
      await api('/sync/campaigns', { method: 'POST' });
      showToast('Синхронизация завершена', 'success');
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  return (
    <header className="bg-white shadow-sm border-b sticky top-0 z-50">
      <div className="max-w-full mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-bold text-purple-600">WB Analytics</h1>
          <span className={`text-xs px-3 py-1 rounded-full ${statusClass}`}>{status}</span>
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-sm text-gray-600">{balance}</span>
          <button onClick={syncAll} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700">
            Синхронизировать
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
