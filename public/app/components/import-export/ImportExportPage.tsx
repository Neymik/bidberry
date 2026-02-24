import React, { useEffect, useState } from 'react';
import { useToast } from '../../hooks/useToast';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';

export default function ImportExportPage() {
  const { showToast } = useToast();
  const { dateFrom, dateTo } = useDateRange();
  const [importHistory, setImportHistory] = useState<any[]>([]);

  useEffect(() => { loadHistory(); }, []);

  async function loadHistory() {
    try {
      const data = await api<any[]>('/import-history');
      setImportHistory(data);
    } catch { /* ignore */ }
  }

  async function importFile(type: string) {
    const input = document.getElementById(`${type}File`) as HTMLInputElement;
    const file = input?.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast('Импорт...');
    try {
      const response = await fetch(`/api/import/${type}`, { method: 'POST', body: formData });
      const result = await response.json() as { success?: boolean; recordsImported?: number };
      if (result.success) {
        showToast(`Импортировано: ${result.recordsImported} записей`, 'success');
        loadHistory();
      } else {
        showToast('Ошибка импорта', 'error');
      }
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
    input.value = '';
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Импорт / Экспорт</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-4">Импорт данных</h3>
            {['campaigns', 'products'].map(type => (
              <div key={type} className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center mb-4">
                <p className="text-gray-600 mb-2">Загрузить {type === 'campaigns' ? 'кампании' : 'товары'}</p>
                <input type="file" id={`${type}File`} accept=".xlsx,.xls" className="hidden" onChange={() => importFile(type)} />
                <label htmlFor={`${type}File`} className="px-4 py-2 bg-purple-600 text-white rounded-lg cursor-pointer hover:bg-purple-700 text-sm">
                  Выбрать файл
                </label>
                <p className="text-sm text-gray-400 mt-2">
                  <a href={`/api/templates/${type}`} className="text-purple-600 hover:underline">Скачать шаблон</a>
                </p>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-lg shadow-md p-6">
            <h3 className="text-lg font-semibold mb-4">Экспорт данных</h3>
            <div className="space-y-2">
              {[
                { label: 'Полный отчёт', href: `/api/export/full-report?dateFrom=${dateFrom}&dateTo=${dateTo}`, color: 'bg-green-600 hover:bg-green-700' },
                { label: 'Кампании', href: `/api/export/campaigns?dateFrom=${dateFrom}&dateTo=${dateTo}`, color: 'bg-gray-200 text-gray-800 hover:bg-gray-300' },
                { label: 'Статистика по дням', href: `/api/export/daily-stats?dateFrom=${dateFrom}&dateTo=${dateTo}`, color: 'bg-gray-200 text-gray-800 hover:bg-gray-300' },
                { label: 'Товары', href: `/api/export/products?dateFrom=${dateFrom}&dateTo=${dateTo}`, color: 'bg-gray-200 text-gray-800 hover:bg-gray-300' },
              ].map(btn => (
                <a key={btn.label} href={btn.href} className={`block text-center px-4 py-2 rounded-lg text-sm font-medium text-white ${btn.color}`}>
                  {btn.label}
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-md p-6">
          <h3 className="text-lg font-semibold mb-4">История импорта</h3>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {importHistory.length === 0 ? (
              <p className="text-gray-500">История пуста</p>
            ) : importHistory.map(h => (
              <div key={h.id} className="bg-gray-50 p-3 rounded-lg">
                <div className="flex justify-between">
                  <span className="font-medium">{h.import_type}</span>
                  <span className={`text-sm ${h.status === 'completed' ? 'text-green-600' : 'text-red-600'}`}>{h.status}</span>
                </div>
                <p className="text-sm text-gray-600">{h.file_name || '-'}</p>
                <p className="text-xs text-gray-400">{new Date(h.started_at).toLocaleString('ru-RU')}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
