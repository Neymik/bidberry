import React from 'react';
import { useToast } from '../../hooks/useToast';

export default function ToastContainer() {
  const { toasts } = useToast();

  return (
    <div className="fixed bottom-4 right-4 space-y-2 z-50">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`px-6 py-3 rounded-lg shadow-lg text-white text-sm animate-[slideUp_0.3s_ease-out] ${
            toast.type === 'success' ? 'bg-green-600' :
            toast.type === 'error' ? 'bg-red-600' :
            'bg-gray-800'
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
