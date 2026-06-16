/**
 * In-memory store for Telegram deep-link login sessions.
 *
 * Flow (no phone, opens the Telegram app):
 *   1. Browser POSTs /api/auth/telegram/deeplink -> we mint a random token,
 *      store it `pending`, and return a `t.me/<bot>?start=<token>` link + QR.
 *   2. User opens Telegram (button or QR) -> the bot receives `/start <token>`
 *      and calls /api/auth/telegram/confirm (localhost + X-Trigger-Secret) with
 *      the authenticated Telegram user. We run the whitelist check and, on
 *      success, attach the issued JWT to the token (`confirmed`).
 *   3. Browser polls /api/auth/telegram/check?token=<token> until it flips to
 *      `confirmed` (gets the session) or `denied`/`expired`.
 *
 * Tokens are ephemeral (5 min) so a plain Map with lazy pruning is enough — the
 * app is a single Bun process. If it restarts mid-login the user just retries.
 */
import { randomBytes } from 'crypto';
import type { AuthResponse } from './auth-service';

const TTL_MS = 5 * 60 * 1000;
export const TTL_SEC = TTL_MS / 1000;

type Entry =
  | { status: 'pending'; expiresAt: number }
  | { status: 'confirmed'; expiresAt: number; auth: AuthResponse }
  | { status: 'denied'; expiresAt: number; error: string };

const store = new Map<string, Entry>();

function prune(): void {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) store.delete(token);
  }
}

export function createToken(): string {
  prune();
  const token = randomBytes(24).toString('hex');
  store.set(token, { status: 'pending', expiresAt: Date.now() + TTL_MS });
  return token;
}

/** Returns the live entry, or null if missing/expired (and deletes if expired). */
export function getEntry(token: string): Entry | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(token);
    return null;
  }
  return entry;
}

/** Attach the issued session to a still-pending token. Returns false if the
 *  token is gone, expired, or already resolved. */
export function markConfirmed(token: string, auth: AuthResponse): boolean {
  const entry = getEntry(token);
  if (!entry || entry.status !== 'pending') return false;
  store.set(token, { status: 'confirmed', auth, expiresAt: entry.expiresAt });
  return true;
}

export function markDenied(token: string, error: string): boolean {
  const entry = getEntry(token);
  if (!entry || entry.status !== 'pending') return false;
  store.set(token, { status: 'denied', error, expiresAt: entry.expiresAt });
  return true;
}

/** Remove a token once the browser has read a terminal state. */
export function consume(token: string): void {
  store.delete(token);
}
