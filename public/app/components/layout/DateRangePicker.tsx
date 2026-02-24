import React from 'react';
import { useDateRange } from '../../hooks/useDateRange';

export default function DateRangePicker({ onApply }: { onApply?: () => void }) {
  const { dateFrom, dateTo, setDateFrom, setDateTo } = useDateRange();

  return (
    <div className="bg-white rounded-lg shadow-md p-4 mb-6">
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">С:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">По:</label>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        {onApply && (
          <button onClick={onApply} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 mt-5">
            Применить
          </button>
        )}
      </div>
    </div>
  );
}
