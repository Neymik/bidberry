import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';

interface Emulator {
  id: number;
  cabinetId: number;
  cabinetName: string;
  status: string;
  monitorStatus: string;
  ordersToday: number;
  lastOrderAt: string | null;
  adbPort: number;
  scrcpyPort: number;
}

export default function EmuPage() {
  const [emu, setEmu] = useState<Emulator | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api<Emulator | null>('/emulators/mine');
      setEmu(data);
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  async function handleAction(action: string, label: string) {
    setActionLoading(action);
    try {
      await api(`/emulators/${action}`, { method: 'POST' });
      showToast(`${label}: успешно`, 'success');
      await load();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return <div className="text-gray-400 p-8">Загрузка...</div>;
  }

  if (!emu) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-gray-800 mb-6">Эмулятор</h1>
        <div className="bg-white rounded-xl shadow-sm border p-8 text-center">
          <svg className="w-16 h-16 mx-auto text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <p className="text-gray-500 text-lg">Эмулятор не назначен</p>
          <p className="text-gray-400 text-sm mt-1">Обратитесь к администратору для назначения эмулятора</p>
        </div>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    running: 'bg-green-100 text-green-700',
    stopped: 'bg-gray-100 text-gray-600',
    error: 'bg-red-100 text-red-700',
    starting: 'bg-yellow-100 text-yellow-700',
    stopping: 'bg-yellow-100 text-yellow-700',
  };

  const statusLabels: Record<string, string> = {
    running: 'Работает',
    stopped: 'Остановлен',
    error: 'Ошибка',
    starting: 'Запускается',
    stopping: 'Останавливается',
  };

  const monitorLabels: Record<string, string> = {
    running: 'Активен',
    stopped: 'Остановлен',
    error: 'Ошибка',
  };

  const isRunning = emu.status === 'running';
  const isMonitorRunning = emu.monitorStatus === 'running';

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Эмулятор</h1>

      {/* Status card */}
      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">
              {emu.cabinetName}
              <span className="text-xs text-gray-400 ml-2">ID: {emu.id}</span>
            </h2>
          </div>
          <div className="flex items-center space-x-2">
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColors[emu.status] || 'bg-gray-100 text-gray-600'}`}>
              {statusLabels[emu.status] || emu.status}
            </span>
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColors[emu.monitorStatus] || 'bg-gray-100 text-gray-600'}`}>
              Монитор: {monitorLabels[emu.monitorStatus] || emu.monitorStatus}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-xs text-gray-500 mb-1">Заказов сегодня</div>
            <div className="text-2xl font-bold text-gray-800">{emu.ordersToday}</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-xs text-gray-500 mb-1">Последний заказ</div>
            <div className="text-sm font-medium text-gray-800">
              {emu.lastOrderAt
                ? new Date(emu.lastOrderAt).toLocaleString('ru-RU')
                : 'Нет данных'}
            </div>
          </div>
        </div>

        {/* Control buttons */}
        <div className="flex items-center space-x-3">
          {isRunning ? (
            <button
              onClick={() => handleAction('stop', 'Остановка эмулятора')}
              disabled={actionLoading !== null}
              className="bg-red-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading === 'stop' ? 'Останавливаем...' : 'Остановить эмулятор'}
            </button>
          ) : (
            <button
              onClick={() => handleAction('start', 'Запуск эмулятора')}
              disabled={actionLoading !== null}
              className="bg-green-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading === 'start' ? 'Запускаем...' : 'Запустить эмулятор'}
            </button>
          )}

          {isMonitorRunning ? (
            <button
              onClick={() => handleAction('monitor/stop', 'Остановка монитора')}
              disabled={actionLoading !== null}
              className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading === 'monitor/stop' ? 'Останавливаем...' : 'Остановить монитор'}
            </button>
          ) : (
            <button
              onClick={() => handleAction('monitor/start', 'Запуск монитора')}
              disabled={actionLoading !== null}
              className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading === 'monitor/start' ? 'Запускаем...' : 'Запустить монитор'}
            </button>
          )}
        </div>
      </div>

      {/* ws-scrcpy iframe */}
      {isRunning && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50">
            <h3 className="text-sm font-medium text-gray-700">Экран эмулятора</h3>
          </div>
          <iframe
            src={`/emu/${emu.id}/`}
            className="w-full border-0"
            style={{ height: '80vh' }}
            title="Эмулятор"
          />
        </div>
      )}
    </div>
  );
}
