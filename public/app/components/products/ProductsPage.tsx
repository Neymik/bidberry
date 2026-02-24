import React, { useEffect, useState } from 'react';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';
import { useToast } from '../../hooks/useToast';

function formatNumber(num: number | null | undefined): string {
  if (num == null) return '-';
  return new Intl.NumberFormat('ru-RU').format(Math.round(num * 100) / 100);
}

const EVENT_TYPES = [
  { value: 'price_change', label: 'Изменение цены' },
  { value: 'photo_update', label: 'Обновление фото' },
  { value: 'description_update', label: 'Обновление описания' },
  { value: 'promotion_start', label: 'Начало акции' },
  { value: 'promotion_end', label: 'Конец акции' },
  { value: 'seo_update', label: 'SEO обновление' },
  { value: 'new_review_response', label: 'Ответ на отзыв' },
  { value: 'stock_replenishment', label: 'Пополнение склада' },
  { value: 'other', label: 'Другое' },
];

export default function ProductsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [analytics, setAnalytics] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [showEventForm, setShowEventForm] = useState(false);
  const [newEvent, setNewEvent] = useState({ event_type: 'other', description: '', event_date: '' });
  const { showToast } = useToast();
  const { dateFrom, dateTo } = useDateRange();

  useEffect(() => { loadProducts(); }, []);

  async function loadProducts() {
    try {
      const data = await api<any[]>('/products');
      setProducts(data);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function viewProduct(nmId: number) {
    try {
      const [product, analyticsData, eventsData] = await Promise.all([
        api<any>(`/products/${nmId}`),
        api<any[]>(`/products/${nmId}/analytics?dateFrom=${dateFrom}&dateTo=${dateTo}`),
        api<any[]>(`/products/${nmId}/events?dateFrom=${dateFrom}&dateTo=${dateTo}`),
      ]);
      setSelectedProduct(product);
      setAnalytics(analyticsData);
      setEvents(eventsData);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function addEvent() {
    if (!selectedProduct || !newEvent.event_date) return;
    try {
      await api('/products/' + selectedProduct.nm_id + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nm_id: selectedProduct.nm_id,
          ...newEvent,
        }),
      });
      showToast('Событие добавлено', 'success');
      setShowEventForm(false);
      setNewEvent({ event_type: 'other', description: '', event_date: '' });
      // Reload events
      const eventsData = await api<any[]>(`/products/${selectedProduct.nm_id}/events?dateFrom=${dateFrom}&dateTo=${dateTo}`);
      setEvents(eventsData);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function deleteEvent(eventId: number) {
    try {
      await api(`/events/${eventId}`, { method: 'DELETE' });
      setEvents(events.filter(e => e.id !== eventId));
      showToast('Событие удалено', 'success');
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Товары</h2>
        <div className="flex gap-2">
          <a href={`/api/export/perechen?dateFrom=${dateFrom}&dateTo=${dateTo}${selectedProduct ? '&nmId=' + selectedProduct.nm_id : ''}`}
             className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
            Скачать отчёт
          </a>
          <a href={`/api/export/products?dateFrom=${dateFrom}&dateTo=${dateTo}`}
             className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg text-sm font-medium hover:bg-gray-300">
            Экспорт в Excel
          </a>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Артикул</th>
              <th className="text-left p-3">Название</th>
              <th className="text-left p-3">Бренд</th>
              <th className="text-left p-3">Категория</th>
              <th className="text-right p-3">Цена</th>
              <th className="text-right p-3">Рейтинг</th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <tr><td colSpan={6} className="text-center p-4 text-gray-500">Нет данных</td></tr>
            ) : products.map(p => (
              <tr key={p.nm_id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => viewProduct(p.nm_id)}>
                <td className="p-3">{p.nm_id}</td>
                <td className="p-3">{p.name || '-'}</td>
                <td className="p-3">{p.brand || '-'}</td>
                <td className="p-3">{p.subject || '-'}</td>
                <td className="p-3 text-right">{formatNumber(p.final_price)} р</td>
                <td className="p-3 text-right">{p.rating ? p.rating.toFixed(1) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedProduct && (
        <div className="mt-6 bg-white rounded-lg shadow-md p-6">
          <h3 className="text-lg font-semibold mb-4">{selectedProduct.name} ({selectedProduct.nm_id})</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div><span className="text-sm text-gray-500">Бренд:</span> <span className="font-medium">{selectedProduct.brand}</span></div>
            <div><span className="text-sm text-gray-500">Цена:</span> <span className="font-medium">{formatNumber(selectedProduct.final_price)} р</span></div>
            <div><span className="text-sm text-gray-500">Рейтинг:</span> <span className="font-medium">{selectedProduct.rating}</span></div>
            <div><span className="text-sm text-gray-500">Отзывы:</span> <span className="font-medium">{selectedProduct.feedbacks}</span></div>
          </div>
          {analytics.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-2">Дата</th>
                  <th className="text-right p-2">Просмотры</th>
                  <th className="text-right p-2">В корзину</th>
                  <th className="text-right p-2">Заказы</th>
                  <th className="text-right p-2">Сумма</th>
                  <th className="text-right p-2">CR корзина</th>
                  <th className="text-right p-2">CR заказ</th>
                </tr>
              </thead>
              <tbody>
                {analytics.map((a: any, i: number) => (
                  <tr key={i} className="border-b">
                    <td className="p-2">{new Date(a.date).toLocaleDateString('ru-RU')}</td>
                    <td className="p-2 text-right">{a.open_card_count}</td>
                    <td className="p-2 text-right">{a.add_to_cart_count}</td>
                    <td className="p-2 text-right">{a.orders_count}</td>
                    <td className="p-2 text-right">{formatNumber(a.orders_sum)} р</td>
                    <td className="p-2 text-right">{a.conversion_to_cart?.toFixed(1)}%</td>
                    <td className="p-2 text-right">{a.conversion_to_order?.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Marketing Events Section */}
          <div className="mt-6">
            <div className="flex justify-between items-center mb-3">
              <h4 className="font-semibold text-gray-700">Маркетинговая активность</h4>
              <button
                onClick={() => setShowEventForm(!showEventForm)}
                className="px-3 py-1 bg-indigo-100 text-indigo-700 rounded text-sm hover:bg-indigo-200"
              >
                {showEventForm ? 'Отмена' : '+ Добавить событие'}
              </button>
            </div>

            {showEventForm && (
              <div className="bg-gray-50 p-4 rounded-lg mb-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <select
                    value={newEvent.event_type}
                    onChange={e => setNewEvent({ ...newEvent, event_type: e.target.value })}
                    className="border rounded px-3 py-2 text-sm"
                  >
                    {EVENT_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={newEvent.event_date}
                    onChange={e => setNewEvent({ ...newEvent, event_date: e.target.value })}
                    className="border rounded px-3 py-2 text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Описание (опционально)"
                    value={newEvent.description}
                    onChange={e => setNewEvent({ ...newEvent, description: e.target.value })}
                    className="border rounded px-3 py-2 text-sm"
                  />
                </div>
                <button
                  onClick={addEvent}
                  className="mt-2 px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700"
                >
                  Сохранить
                </button>
              </div>
            )}

            {events.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2">Дата</th>
                    <th className="text-left p-2">Тип</th>
                    <th className="text-left p-2">Описание</th>
                    <th className="text-right p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e: any) => (
                    <tr key={e.id} className="border-b">
                      <td className="p-2">{new Date(e.event_date).toLocaleDateString('ru-RU')}</td>
                      <td className="p-2">{EVENT_TYPES.find(t => t.value === e.event_type)?.label || e.event_type}</td>
                      <td className="p-2">{e.description || '-'}</td>
                      <td className="p-2 text-right">
                        <button
                          onClick={() => deleteEvent(e.id)}
                          className="text-red-500 hover:text-red-700 text-xs"
                        >
                          Удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-gray-400 text-sm">Нет маркетинговых событий за выбранный период</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
