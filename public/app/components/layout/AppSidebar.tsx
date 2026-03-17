import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useDateRange } from '../../hooks/useDateRange';
import { useAuth } from '../../hooks/useAuth';

const navItems = [
  { path: '/', label: 'Дашборд', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { path: '/campaigns', label: 'Кампании', icon: 'M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z' },
  { path: '/products', label: 'Товары', icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
  { path: '/keywords', label: 'Ключевые слова', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
  { path: '/financial', label: 'Финансы', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  { path: '/import-export', label: 'Импорт/Экспорт', icon: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12' },
  { path: '/monitoring', label: 'Мониторинг CPS', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
];

const reportSections = [
  { key: 'voronka', label: 'Воронка' },
  { key: 'orders', label: 'Лента заказов' },
  { key: 'stocks', label: 'Остатки' },
  { key: 'traffic', label: 'Точки входа' },
  { key: 'marketing', label: 'Маркетинг' },
  { key: 'campaigns', label: 'Рекламные компании' },
  { key: 'clusters', label: 'Кластеры' },
];

export default function AppSidebar() {
  const { dateFrom, dateTo } = useDateRange();
  const { isAdmin } = useAuth();
  const [reportsOpen, setReportsOpen] = useState(false);

  return (
    <aside className="w-56 bg-white shadow-sm min-h-[calc(100vh-57px)] border-r flex-shrink-0">
      <nav className="py-4">
        {navItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `flex items-center px-4 py-3 text-sm transition-colors ${
                isActive
                  ? 'bg-purple-50 text-purple-700 border-r-2 border-purple-600 font-medium'
                  : 'text-gray-600 hover:bg-gray-50'
              }`
            }
          >
            <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon} />
            </svg>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t mx-3" />

      <div className="py-2">
        <button
          onClick={() => setReportsOpen(!reportsOpen)}
          className="flex items-center justify-between w-full px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <span className="flex items-center">
            <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Отчёты
          </span>
          <svg
            className={`w-4 h-4 transition-transform ${reportsOpen ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {reportsOpen && (
          <div className="pb-2">
            {reportSections.map(section => (
              <a
                key={section.key}
                href={`/api/export/perechen/${section.key}?dateFrom=${dateFrom}&dateTo=${dateTo}`}
                className="flex items-center px-4 py-1.5 pl-12 text-xs text-gray-500 hover:text-purple-700 hover:bg-purple-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {section.label}
              </a>
            ))}
          </div>
        )}
      </div>

      {isAdmin && (
        <>
          <div className="border-t mx-3" />
          <nav className="py-2">
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `flex items-center px-4 py-3 text-sm transition-colors ${
                  isActive
                    ? 'bg-purple-50 text-purple-700 border-r-2 border-purple-600 font-medium'
                    : 'text-gray-600 hover:bg-gray-50'
                }`
              }
            >
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Админ
            </NavLink>
            <NavLink
              to="/admin/emu-web"
              className={({ isActive }) =>
                `flex items-center px-4 py-3 text-sm transition-colors ${
                  isActive
                    ? 'bg-purple-50 text-purple-700 border-r-2 border-purple-600 font-medium'
                    : 'text-gray-600 hover:bg-gray-50'
                }`
              }
            >
              <svg className="w-5 h-5 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              Эмулятор
            </NavLink>
          </nav>
        </>
      )}
    </aside>
  );
}
