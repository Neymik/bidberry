import React from 'react';

// Maps backend error codes/messages (passed via ?login_error=) to friendly text.
function friendlyError(raw: string): string {
  const msg = decodeURIComponent(raw);
  if (/whitelist|denied/i.test(msg)) return 'Доступ запрещён: ваш аккаунт не в списке разрешённых.';
  if (msg === 'missing_code') return 'Вход не завершён. Попробуйте ещё раз.';
  if (/state/i.test(msg)) return 'Сессия входа устарела. Попробуйте ещё раз.';
  if (/access_denied/i.test(msg)) return 'Вы отменили вход в Telegram.';
  return msg;
}

export default function LoginPage() {
  const params = new URLSearchParams(window.location.search);
  const loginError = params.get('login_error');

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-900">BidBerry</h1>
          <p className="text-gray-500 mt-2">WB Analytics Dashboard</p>
        </div>

        <p className="text-gray-600 text-center mb-6">
          Войдите через Telegram для доступа к аналитике
        </p>

        {loginError && (
          <div className="bg-red-50 text-red-600 text-sm p-3 rounded-lg text-center mb-4">
            {friendlyError(loginError)}
          </div>
        )}

        <a
          href="/api/auth/telegram/oidc/start"
          className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-sky-500 hover:bg-sky-600 text-white font-medium rounded-lg transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor" aria-hidden="true">
            <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.14-3.05-1.99 1.93c-.23.23-.42.42-.83.42z" />
          </svg>
          Войти через Telegram
        </a>

        <div className="border-t mt-6 pt-4">
          <p className="text-xs text-gray-400 text-center">
            Доступ только для пользователей из белого списка. При первом входе аккаунт создаётся автоматически.
          </p>
        </div>
      </div>
    </div>
  );
}
