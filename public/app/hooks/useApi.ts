export async function api<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('token');
  const cabinetId = localStorage.getItem('selectedCabinetId');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (cabinetId) headers['X-Cabinet-Id'] = cabinetId;

  const response = await fetch(`/api${endpoint}`, {
    headers,
    ...options,
  });

  if (response.status === 401) {
    localStorage.removeItem('token');
    window.location.reload();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let message = '';

    if (contentType.includes('application/json')) {
      const payload = await response.json().catch(() => null) as Record<string, any> | null;
      if (payload) {
        message = String(payload.error || payload.message || '');
      }
    } else {
      message = await response.text().catch(() => '');
    }

    message = (message || '').trim();
    if (!message) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const shortMessage = message.length > 400 ? `${message.slice(0, 400)}...` : message;
    throw new Error(`HTTP ${response.status}: ${shortMessage}`);
  }

  return response.json() as Promise<T>;
}
