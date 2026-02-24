import React, { useEffect, useState } from 'react';
import { api } from '../../hooks/useApi';
import { useToast } from '../../hooks/useToast';

export default function KeywordsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [selectedNmId, setSelectedNmId] = useState<number | null>(null);
  const [keywords, setKeywords] = useState<any[]>([]);
  const [recommended, setRecommended] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [positions, setPositions] = useState<any[]>([]);
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    api<any[]>('/products').then(setProducts).catch(() => {});
  }, []);

  async function loadKeywords(nmId: number) {
    setSelectedNmId(nmId);
    setSelectedKeyword(null);
    setPositions([]);
    try {
      const data = await api<any[]>(`/products/${nmId}/keywords`);
      setKeywords(data);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function addKeyword() {
    if (!selectedNmId || !newKeyword.trim()) return;
    try {
      await api(`/products/${selectedNmId}/keywords`, {
        method: 'POST',
        body: JSON.stringify({ keyword: newKeyword.trim() }),
      });
      setNewKeyword('');
      showToast('Ключевое слово добавлено', 'success');
      loadKeywords(selectedNmId);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function removeKeyword(keyword: string) {
    if (!selectedNmId) return;
    try {
      await api(`/products/${selectedNmId}/keywords/${encodeURIComponent(keyword)}`, { method: 'DELETE' });
      showToast('Удалено', 'success');
      loadKeywords(selectedNmId);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function fetchRecommended() {
    if (!selectedNmId) return;
    try {
      const data = await api<any>(`/products/${selectedNmId}/keywords/recommended`, { method: 'POST' });
      setRecommended(data.keywords || []);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function viewPositions(keyword: string) {
    if (!selectedNmId) return;
    setSelectedKeyword(keyword);
    try {
      const data = await api<any[]>(`/products/${selectedNmId}/keywords/${encodeURIComponent(keyword)}/positions`);
      setPositions(data);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function checkPositions() {
    if (!selectedNmId) return;
    showToast('Проверка позиций...');
    try {
      await api(`/sync/keyword-positions/${selectedNmId}`, { method: 'POST' });
      showToast('Позиции обновлены', 'success');
      if (selectedKeyword) viewPositions(selectedKeyword);
    } catch (e: any) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Ключевые слова</h2>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow-md p-4">
          <h3 className="font-semibold mb-3">Выберите товар</h3>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {products.map(p => (
              <button
                key={p.nm_id}
                onClick={() => loadKeywords(p.nm_id)}
                className={`w-full text-left px-3 py-2 rounded text-sm ${selectedNmId === p.nm_id ? 'bg-purple-50 text-purple-700' : 'hover:bg-gray-50'}`}
              >
                <div className="font-medium">{p.nm_id}</div>
                <div className="text-xs text-gray-500 truncate">{p.name || '-'}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="lg:col-span-2">
          {selectedNmId ? (
            <div className="space-y-4">
              <div className="bg-white rounded-lg shadow-md p-4">
                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="text"
                    value={newKeyword}
                    onChange={e => setNewKeyword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addKeyword()}
                    placeholder="Добавить ключевое слово..."
                    className="flex-1 border rounded-lg px-3 py-2 text-sm"
                  />
                  <button onClick={addKeyword} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700">Добавить</button>
                  <button onClick={fetchRecommended} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Рекомендации</button>
                  <button onClick={checkPositions} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700">Проверить</button>
                </div>

                {recommended.length > 0 && (
                  <div className="mb-4 p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm font-medium mb-2">Рекомендуемые:</p>
                    <div className="flex flex-wrap gap-1">
                      {recommended.map(kw => (
                        <button
                          key={kw}
                          onClick={() => { setNewKeyword(kw); }}
                          className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs hover:bg-blue-200"
                        >{kw}</button>
                      ))}
                    </div>
                  </div>
                )}

                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-2">Ключевое слово</th>
                      <th className="text-right p-2">Частотность</th>
                      <th className="text-center p-2">Источник</th>
                      <th className="text-right p-2">Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map((kw: any) => (
                      <tr key={kw.id} className="border-b hover:bg-gray-50">
                        <td className="p-2">
                          <button onClick={() => viewPositions(kw.keyword)} className="text-purple-600 hover:underline">{kw.keyword}</button>
                        </td>
                        <td className="p-2 text-right">{kw.frequency}</td>
                        <td className="p-2 text-center text-xs">{kw.source}</td>
                        <td className="p-2 text-right">
                          <button onClick={() => removeKeyword(kw.keyword)} className="text-red-500 hover:underline text-xs">Удалить</button>
                        </td>
                      </tr>
                    ))}
                    {keywords.length === 0 && (
                      <tr><td colSpan={4} className="text-center p-4 text-gray-500">Нет ключевых слов</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {selectedKeyword && (
                <div className="bg-white rounded-lg shadow-md p-4">
                  <h4 className="font-medium mb-2">Позиции: {selectedKeyword}</h4>
                  {positions.length === 0 ? (
                    <p className="text-gray-500 text-sm">Нет данных о позициях. Нажмите "Проверить".</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left p-2">Дата</th>
                          <th className="text-right p-2">Позиция</th>
                          <th className="text-right p-2">Страница</th>
                          <th className="text-right p-2">Частотность</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((pos: any) => (
                          <tr key={pos.id} className="border-b">
                            <td className="p-2">{new Date(pos.checked_at).toLocaleString('ru-RU')}</td>
                            <td className="p-2 text-right">{pos.position || '-'}</td>
                            <td className="p-2 text-right">{pos.page || '-'}</td>
                            <td className="p-2 text-right">{pos.frequency}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-md p-8 text-center text-gray-500">
              Выберите товар для управления ключевыми словами
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
