import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';

interface TelegramAuthData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export default function LoginPage() {
  const { login } = useAuth();
  const widgetRef = useRef<HTMLDivElement>(null);
  const [botName, setBotName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/auth/config')
      .then((r) => r.json() as Promise<{ telegram_bot_name: string }>)
      .then((cfg) => setBotName(cfg.telegram_bot_name))
      .catch(() => setError('Failed to load config'));
  }, []);

  useEffect(() => {
    (window as any).onTelegramAuth = async (tgUser: TelegramAuthData) => {
      try {
        const res = await fetch('/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tgUser),
        });
        if (!res.ok) {
          const err = await res.json() as { error?: string };
          setError(err.error || 'Auth error');
          return;
        }
        const data = await res.json() as { access_token: string; expires_at: string; user: any };
        login(data);
      } catch {
        setError('Network error');
      }
    };
  }, [login]);

  useEffect(() => {
    if (botName && widgetRef.current && !widgetRef.current.querySelector('script')) {
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.setAttribute('data-telegram-login', botName);
      script.setAttribute('data-size', 'large');
      script.setAttribute('data-radius', '8');
      script.setAttribute('data-onauth', 'onTelegramAuth(user)');
      script.setAttribute('data-request-access', 'write');
      widgetRef.current.appendChild(script);
    }
  }, [botName]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">BidBerry</h1>
          <p className="text-gray-500 mt-2">WB Analytics Dashboard</p>
        </div>

        <div className="space-y-6">
          <div className="text-center">
            <p className="text-gray-600 mb-4">Войдите через Telegram для доступа к аналитике</p>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 text-sm p-3 rounded-lg text-center">{error}</div>
          )}

          <div ref={widgetRef} className="flex justify-center min-h-[50px]">
            {!botName && !error && (
              <p className="text-gray-400 text-sm">Loading...</p>
            )}
          </div>

          <div className="border-t pt-4">
            <p className="text-xs text-gray-400 text-center">
              Авторизация доступна только через Telegram.
              При первом входе аккаунт создается автоматически.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
