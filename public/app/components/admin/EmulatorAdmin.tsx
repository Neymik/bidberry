import React, { useState, useEffect } from 'react';
import { api } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';

interface EmulatorInstance {
  id: number;
  cabinetId: number;
  cabinetName: string;
  status: string;
  monitorStatus: string;
  adbPort: number;
  scrcpyPort: number;
  createdAt: string;
}

interface Account {
  id: number;
  name: string;
  cabinets: { id: number; name: string; is_active: boolean }[];
}

export default function EmulatorAdmin() {
  const [emulators, setEmulators] = useState<EmulatorInstance[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCabinetId, setSelectedCabinetId] = useState<string>('');
  const [actionLoading, setActionLoading] = useState<number | string | null>(null);
  const { showToast } = useToast();

  async function load() {
    try {
      const [emuData, accData] = await Promise.all([
        api<EmulatorInstance[]>('/admin/emulators'),
        api<Account[]>('/admin/accounts'),
      ]);
      setEmulators(emuData);
      setAccounts(accData);
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Collect all cabinets that already have an emulator assigned
  const assignedCabinetIds = new Set(emulators.map(e => e.cabinetId));

  // Build list of unassigned cabinets from all accounts
  const unassignedCabinets: { id: number; label: string }[] = [];
  for (const account of accounts) {
    if (!account.cabinets) continue;
    for (const cab of account.cabinets) {
      if (!assignedCabinetIds.has(cab.id)) {
        unassignedCabinets.push({ id: cab.id, label: `${account.name} / ${cab.name}` });
      }
    }
  }

  async function createEmulator() {
    if (!selectedCabinetId) return;
    setActionLoading('create');
    try {
      await api('/admin/emulators', {
        method: 'POST',
        body: JSON.stringify({ cabinetId: Number(selectedCabinetId) }),
      });
      setSelectedCabinetId('');
      showToast('Эмулятор создан', 'success');
      await load();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setActionLoading(null);
    }
  }

  async function restartEmulator(id: number) {
    setActionLoading(id);
    try {
      await api(`/admin/emulators/${id}/restart`, { method: 'POST' });
      showToast('Эмулятор перезапускается', 'success');
      await load();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setActionLoading(null);
    }
  }

  async function deleteEmulator(id: number, name: string) {
    if (!confirm(`Удалить эмулятор "${name}" (ID: ${id})?`)) return;
    setActionLoading(id);
    try {
      await api(`/admin/emulators/${id}`, { method: 'DELETE' });
      showToast('Эмулятор удалён', 'success');
      await load();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) return <div className="text-gray-400">Загрузка...</div>;

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

  return (
    <div className="space-y-6">
      {/* Create emulator form */}
      <div className="flex items-center space-x-3">
        <select
          value={selectedCabinetId}
          onChange={e => setSelectedCabinetId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-72 focus:ring-2 focus:ring-purple-500"
        >
          <option value="">Выберите кабинет...</option>
          {unassignedCabinets.map(cab => (
            <option key={cab.id} value={cab.id}>{cab.label}</option>
          ))}
        </select>
        <button
          onClick={createEmulator}
          disabled={!selectedCabinetId || actionLoading === 'create'}
          className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {actionLoading === 'create' ? 'Создание...' : 'Создать эмулятор'}
        </button>
      </div>

      {/* Emulators table */}
      <div className="bg-white rounded-xl shadow-sm border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs border-b">
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Кабинет</th>
              <th className="px-4 py-3">Статус</th>
              <th className="px-4 py-3">Монитор</th>
              <th className="px-4 py-3">ADB порт</th>
              <th className="px-4 py-3">Scrcpy порт</th>
              <th className="px-4 py-3">Создан</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {emulators.map(emu => (
              <tr key={emu.id} className="border-t border-gray-50 hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-400">{emu.id}</td>
                <td className="px-4 py-3 font-medium">{emu.cabinetName}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[emu.status] || 'bg-gray-100 text-gray-600'}`}>
                    {statusLabels[emu.status] || emu.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[emu.monitorStatus] || 'bg-gray-100 text-gray-600'}`}>
                    {monitorLabels[emu.monitorStatus] || emu.monitorStatus}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{emu.adbPort}</td>
                <td className="px-4 py-3 text-gray-500">{emu.scrcpyPort}</td>
                <td className="px-4 py-3 text-xs text-gray-400">
                  {emu.createdAt ? new Date(emu.createdAt).toLocaleDateString('ru-RU') : '-'}
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button
                    onClick={() => restartEmulator(emu.id)}
                    disabled={actionLoading === emu.id}
                    className="text-xs text-purple-600 hover:text-purple-800 disabled:opacity-50"
                  >
                    Перезапуск
                  </button>
                  <button
                    onClick={() => deleteEmulator(emu.id, emu.cabinetName)}
                    disabled={actionLoading === emu.id}
                    className="text-xs text-red-400 hover:text-red-600 disabled:opacity-50"
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {emulators.length === 0 && (
          <div className="text-gray-400 text-center py-8">Нет эмуляторов</div>
        )}
      </div>
    </div>
  );
}
