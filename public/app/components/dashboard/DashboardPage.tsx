import React, { useEffect, useState, useRef } from 'react';
import { api } from '../../hooks/useApi';
import { useDateRange } from '../../hooks/useDateRange';
import { useToast } from '../../hooks/useToast';
import DateRangePicker from '../layout/DateRangePicker';

function formatNumber(num: number | null | undefined): string {
  if (num == null) return '-';
  return new Intl.NumberFormat('ru-RU').format(Math.round(num * 100) / 100);
}

export default function DashboardPage() {
  const { dateFrom, dateTo } = useDateRange();
  const { showToast } = useToast();
  const [summary, setSummary] = useState<any>(null);
  const [dailyStats, setDailyStats] = useState<any[]>([]);
  const spendChartRef = useRef<HTMLCanvasElement>(null);
  const metricsChartRef = useRef<HTMLCanvasElement>(null);
  const chartInstances = useRef<any[]>([]);

  async function loadDashboard() {
    try {
      const data = await api<any>(`/dashboard?dateFrom=${dateFrom}&dateTo=${dateTo}`);
      setSummary(data.summary);
      setDailyStats(data.dailyStats || []);
    } catch (e: any) {
      showToast('Ошибка загрузки: ' + e.message, 'error');
    }
  }

  useEffect(() => { loadDashboard(); }, [dateFrom, dateTo]);

  useEffect(() => {
    if (!dailyStats.length) return;
    // Dynamic Chart.js import
    // @ts-ignore CDN dynamic import
    import('https://cdn.jsdelivr.net/npm/chart.js/+esm').then((ChartModule: any) => {
      const Chart = ChartModule.Chart || ChartModule.default?.Chart;
      if (!Chart) return;

      // Register all components
      if (Chart.register) {
        const components = ChartModule.registerables || ChartModule.default?.registerables;
        if (components) Chart.register(...components);
      }

      // Destroy old charts
      chartInstances.current.forEach(c => c.destroy());
      chartInstances.current = [];

      const labels = dailyStats.map((d: any) => d.date).reverse();
      const spendData = dailyStats.map((d: any) => d.total_spend).reverse();
      const revenueData = dailyStats.map((d: any) => d.total_order_sum).reverse();

      if (spendChartRef.current) {
        chartInstances.current.push(new Chart(spendChartRef.current, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: 'Расход', data: spendData, backgroundColor: 'rgba(147, 51, 234, 0.8)' },
              { label: 'Выручка', data: revenueData, backgroundColor: 'rgba(34, 197, 94, 0.8)' },
            ],
          },
          options: { responsive: true, scales: { y: { beginAtZero: true } } },
        }));
      }

      if (metricsChartRef.current) {
        const ctrData = dailyStats.map((d: any) => d.avg_ctr).reverse();
        const roasData = dailyStats.map((d: any) => d.roas).reverse();
        chartInstances.current.push(new Chart(metricsChartRef.current, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: 'CTR, %', data: ctrData, borderColor: 'rgb(59, 130, 246)', tension: 0.3, yAxisID: 'y' },
              { label: 'ROAS', data: roasData, borderColor: 'rgb(234, 88, 12)', tension: 0.3, yAxisID: 'y1' },
            ],
          },
          options: {
            responsive: true,
            scales: {
              y: { position: 'left', beginAtZero: true },
              y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } },
            },
          },
        }));
      }
    }).catch(() => {});

    return () => {
      chartInstances.current.forEach(c => c.destroy());
      chartInstances.current = [];
    };
  }, [dailyStats]);

  return (
    <div>
      <DateRangePicker onApply={loadDashboard} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {[
          { label: 'Расход', value: summary ? formatNumber(summary.totalSpend) + ' р' : '-', color: 'from-purple-500 to-purple-700' },
          { label: 'Заказы', value: summary ? formatNumber(summary.totalOrders) : '-', color: 'from-blue-500 to-blue-700' },
          { label: 'Выручка', value: summary ? formatNumber(summary.totalRevenue) + ' р' : '-', color: 'from-green-500 to-green-700' },
          { label: 'ROAS', value: summary?.roas ? summary.roas.toFixed(2) : '-', color: 'from-orange-500 to-orange-700' },
        ].map((card, i) => (
          <div key={i} className={`bg-gradient-to-br ${card.color} text-white rounded-xl p-6`}>
            <p className="text-white/70 text-sm">{card.label}</p>
            <p className="text-3xl font-bold mt-2">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow-md p-6">
          <h3 className="text-lg font-semibold mb-4">Расходы и выручка</h3>
          <canvas ref={spendChartRef}></canvas>
        </div>
        <div className="bg-white rounded-lg shadow-md p-6">
          <h3 className="text-lg font-semibold mb-4">Показатели эффективности</h3>
          <canvas ref={metricsChartRef}></canvas>
        </div>
      </div>

      <div className="flex gap-2">
        <a href={`/api/export/full-report?dateFrom=${dateFrom}&dateTo=${dateTo}`} className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700">
          Скачать полный отчёт
        </a>
        <a href={`/api/export/daily-stats?dateFrom=${dateFrom}&dateTo=${dateTo}`} className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg text-sm font-medium hover:bg-gray-300">
          Экспорт по дням
        </a>
      </div>
    </div>
  );
}
