import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';

interface DeepLink {
  token: string;
  bot: string;
  url: string;
  qr: string; // inline SVG markup
  expires_in: number;
}

type CheckResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'denied'; error?: string }
  | { status: 'confirmed'; access_token: string; expires_at: string; user: any };

export default function LoginPage() {
  const { login } = useAuth();
  const [link, setLink] = useState<DeepLink | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function generate() {
    stopPolling();
    setError('');
    setExpired(false);
    setLink(null);
    try {
      const res = await fetch('/api/auth/telegram/deeplink', { method: 'POST' });
      if (!res.ok) {
        setError('Не удалось создать ссылку для входа');
        return;
      }
      setLink((await res.json()) as DeepLink);
    } catch {
      setError('Ошибка сети');
    }
  }

  // Generate a link on mount.
  useEffect(() => {
    generate();
    return stopPolling;
  }, []);

  // Poll for confirmation while we have a live link.
  useEffect(() => {
    if (!link) return;
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/auth/telegram/check?token=${encodeURIComponent(link.token)}`);
        const data = (await res.json()) as CheckResponse;
        if (data.status === 'confirmed') {
          stopPolling();
          login(data);
        } else if (data.status === 'denied') {
          stopPolling();
          setError(data.error || 'Доступ запрещён: аккаунт не в списке разрешённых');
        } else if (data.status === 'expired') {
          stopPolling();
          setExpired(true);
        }
      } catch {
        /* transient network error — keep polling */
      }
    }, 2500);
    return stopPolling;
  }, [link, login]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-900">BidBerry</h1>
          <p className="text-gray-500 mt-2">WB Analytics Dashboard</p>
        </div>

        <p className="text-gray-600 text-center mb-6">Войдите через Telegram для доступа к аналитике</p>

        {error && (
          <div className="bg-red-50 text-red-600 text-sm p-3 rounded-lg text-center mb-4">{error}</div>
        )}

        {expired && (
          <div className="text-center space-y-4">
            <p className="text-gray-500 text-sm">Ссылка для входа устарела.</p>
            <button
              onClick={generate}
              className="px-5 py-2.5 bg-sky-500 hover:bg-sky-600 text-white font-medium rounded-lg transition-colors"
            >
              Обновить
            </button>
          </div>
        )}

        {!expired && !error && (
          <div className="space-y-5">
            <div className="flex justify-center">
              {link ? (
                <div
                  className="w-52 h-52 [&>svg]:w-full [&>svg]:h-full p-2 bg-white rounded-xl border border-gray-100"
                  // QR is server-generated SVG of the t.me deep link.
                  dangerouslySetInnerHTML={{ __html: link.qr }}
                />
              ) : (
                <div className="w-52 h-52 flex items-center justify-center text-gray-400 text-sm">
                  Загрузка…
                </div>
              )}
            </div>

            {link && (
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full px-5 py-3 bg-sky-500 hover:bg-sky-600 text-white font-medium rounded-lg transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor" aria-hidden="true">
                  <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.14-3.05-1.99 1.93c-.23.23-.42.42-.83.42z" />
                </svg>
                Открыть Telegram
              </a>
            )}

            <p className="text-xs text-gray-400 text-center leading-relaxed">
              Отсканируйте QR-код камерой телефона или нажмите кнопку, затем
              нажмите <b>Start</b> в боте {link?.bot ? `@${link.bot}` : ''}. Телефон вводить не нужно.
            </p>
          </div>
        )}

        <div className="border-t mt-6 pt-4">
          <p className="text-xs text-gray-400 text-center">
            Доступ только для пользователей из белого списка. При первом входе аккаунт создаётся автоматически.
          </p>
        </div>
      </div>
    </div>
  );
}
