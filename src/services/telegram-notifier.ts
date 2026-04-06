/**
 * Telegram notification service.
 * Sends messages to a chat via Telegram Bot API, optionally through a proxy
 * (needed when deployed in Russia — Telegram is blocked).
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   — required, bot token from @BotFather
 *   TELEGRAM_CHAT_ID     — required, target chat ID
 *   TELEGRAM_PROXY_URL   — optional, e.g. "http://127.0.0.1:3128"
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export async function sendTelegramMessage(
  text: string,
  options: { chatId?: string; parseMode?: 'HTML' | 'Markdown' } = {}
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set, skipping message');
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: options.parseMode || 'HTML',
  });

  const fetchOptions: RequestInit & { proxy?: string } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  };
  const proxy = process.env.TELEGRAM_PROXY_URL;
  if (proxy) fetchOptions.proxy = proxy;

  try {
    const res = await fetch(url, fetchOptions as RequestInit);
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[telegram] ${res.status} ${errText}`);
    }
  } catch (e: any) {
    console.error(`[telegram] send failed: ${e.message}`);
  }
}
