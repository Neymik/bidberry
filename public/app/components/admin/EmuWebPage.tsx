import React, { useEffect } from 'react';
import { useAuth } from '../../hooks/useAuth';

export default function EmuWebPage() {
  const { isAdmin } = useAuth();

  useEffect(() => {
    if (isAdmin) {
      // Open ws-scrcpy directly — avoids iframe WebSocket routing issues
      window.location.href = '/emu-proxy/';
    }
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="p-8 text-center text-gray-500">
        Доступ запрещён. Требуются права администратора.
      </div>
    );
  }

  return (
    <div className="p-8 text-center text-gray-500">
      Перенаправление на эмулятор...
    </div>
  );
}
