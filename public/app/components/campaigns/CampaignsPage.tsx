import React, { useEffect, useState } from 'react';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';
import { useToast } from '../../hooks/useToast';

function formatNumber(num: number | null | undefined): string {
  if (num == null) return '-';
  return new Intl.NumberFormat('ru-RU').format(Math.round(num * 100) / 100);
}

function getStatusClass(status: string): string {
  const classes: Record<string, string> = {
    'Активна': 'bg-green-100 text-green-800',
    'Приостановлена': 'bg-yellow-100 text-yellow-800',
    'Завершена': 'bg-gray-100 text-gray-800',
    'Удалена': 'bg-red-100 text-red-800',
  };
  return classes[status] || 'bg-gray-100 text-gray-800';
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<number | null>(null);
  const [bidRules, setBidRules] = useState<any[]>([]);
  const [bidHistory, setBidHistory] = useState<any[]>([]);
  const { showToast } = useToast();
  const { dateFrom, dateTo } = useDateRange();

  useEffect(() => { loadCampaigns(); }, []);

  async function loadCampaigns() {
    try {
      const data = await api<any[]>('/campaigns');
      setCampaigns(data);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function syncBids(campaignId: number) {
    showToast('Загрузка ставок...');
    try {
      await api(`/sync/bids/${campaignId}`, { method: 'POST' });
      showToast('Ставки загружены', 'success');
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function viewBidRules(campaignId: number) {
    setSelectedCampaign(campaignId);
    try {
      const [rules, history] = await Promise.all([
        api<any[]>(`/campaigns/${campaignId}/bid-rules`),
        api<any[]>(`/campaigns/${campaignId}/bid-history`),
      ]);
      setBidRules(rules);
      setBidHistory(history);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function addBidRule(campaignId: number) {
    try {
      await api(`/campaigns/${campaignId}/bid-rules`, {
        method: 'POST',
        body: JSON.stringify({
          strategy: 'drr_target',
          target_value: 15,
          min_bid: 50,
          max_bid: 500,
          step: 10,
        }),
      });
      showToast('Правило создано', 'success');
      viewBidRules(campaignId);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function adjustBids(campaignId: number) {
    showToast('Корректировка ставок...');
    try {
      const result = await api<any>(`/campaigns/${campaignId}/adjust-bids`, { method: 'POST' });
      showToast(`Скорректировано: ${result.adjusted}, ошибок: ${result.errors}`, 'success');
      viewBidRules(campaignId);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Рекламные кампании</h2>
        <a href={`/api/export/campaigns?dateFrom=${dateFrom}&dateTo=${dateTo}`} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg text-sm font-medium hover:bg-gray-300">
          Экспорт в Excel
        </a>
      </div>

      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">ID</th>
              <th className="text-left p-3">Название</th>
              <th className="text-left p-3">Тип</th>
              <th className="text-left p-3">Статус</th>
              <th className="text-right p-3">Бюджет</th>
              <th className="text-right p-3">Действия</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 ? (
              <tr><td colSpan={6} className="text-center p-4 text-gray-500">Нет данных. Синхронизируйте с WB.</td></tr>
            ) : campaigns.map(c => (
              <tr key={c.campaign_id} className="border-b hover:bg-gray-50">
                <td className="p-3">{c.campaign_id}</td>
                <td className="p-3">{c.name || '-'}</td>
                <td className="p-3">{c.type || '-'}</td>
                <td className="p-3">
                  <span className={`px-2 py-1 rounded-full text-xs ${getStatusClass(c.status)}`}>{c.status || '-'}</span>
                </td>
                <td className="p-3 text-right">{formatNumber(c.daily_budget)} р</td>
                <td className="p-3 text-right space-x-2">
                  <button onClick={() => syncBids(c.campaign_id)} className="text-purple-600 hover:underline text-sm">Ставки</button>
                  <button onClick={() => viewBidRules(c.campaign_id)} className="text-blue-600 hover:underline text-sm">Биддер</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedCampaign && (
        <div className="mt-6 bg-white rounded-lg shadow-md p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold">Биддер - Кампания #{selectedCampaign}</h3>
            <div className="space-x-2">
              <button onClick={() => addBidRule(selectedCampaign)} className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700">+ Правило</button>
              <button onClick={() => adjustBids(selectedCampaign)} className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700">Применить</button>
            </div>
          </div>

          {bidRules.length === 0 ? (
            <p className="text-gray-500 text-sm">Нет правил. Создайте первое правило автоставок.</p>
          ) : (
            <table className="w-full text-sm mb-6">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-2">Стратегия</th>
                  <th className="text-right p-2">Цель</th>
                  <th className="text-right p-2">Мин</th>
                  <th className="text-right p-2">Макс</th>
                  <th className="text-right p-2">Шаг</th>
                  <th className="text-center p-2">Активно</th>
                </tr>
              </thead>
              <tbody>
                {bidRules.map((r: any) => (
                  <tr key={r.id} className="border-b">
                    <td className="p-2">{r.strategy}</td>
                    <td className="p-2 text-right">{r.target_value}</td>
                    <td className="p-2 text-right">{r.min_bid}</td>
                    <td className="p-2 text-right">{r.max_bid}</td>
                    <td className="p-2 text-right">{r.step}</td>
                    <td className="p-2 text-center">{r.is_active ? 'Да' : 'Нет'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {bidHistory.length > 0 && (
            <>
              <h4 className="font-medium mb-2">История изменений</h4>
              <div className="max-h-48 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-2">Время</th>
                      <th className="text-left p-2">Ключевое слово</th>
                      <th className="text-right p-2">Было</th>
                      <th className="text-right p-2">Стало</th>
                      <th className="text-left p-2">Причина</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bidHistory.map((h: any) => (
                      <tr key={h.id} className="border-b">
                        <td className="p-2 text-xs">{new Date(h.created_at).toLocaleString('ru-RU')}</td>
                        <td className="p-2">{h.keyword || '-'}</td>
                        <td className="p-2 text-right">{h.old_bid}</td>
                        <td className="p-2 text-right">{h.new_bid}</td>
                        <td className="p-2 text-xs">{h.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
