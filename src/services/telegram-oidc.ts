/**
 * Telegram OpenID Connect login (https://core.telegram.org/bots/telegram-login).
 *
 * Authorization Code flow with PKCE:
 *   1. buildAuthUrl()   — mint state + PKCE verifier, return the oauth.telegram.org
 *                         /auth URL the browser is redirected to.
 *   2. exchangeCode()   — on callback, swap code+verifier for an id_token at
 *                         /token (back-channel, HTTP Basic client auth), then
 *                         validate iss/aud/exp and extract the Telegram profile.
 *
 * Trust model: the id_token is received directly from Telegram's token endpoint
 * over our own TLS connection (not via the browser), so per OIDC Core §3.1.3.7
 * signature validation MAY be skipped for the code flow. We still check
 * iss / aud / exp. The `id` claim is the numeric Telegram user id — the same key
 * our whitelist (allowed_users.telegram_id) and users table use, so existing
 * accounts keep working unchanged.
 *
 * Env:
 *   TELEGRAM_OIDC_CLIENT_ID      — Client ID from @BotFather → Bot Settings → Web Login
 *   TELEGRAM_OIDC_CLIENT_SECRET  — Client Secret (keep in .env, never commit)
 */

import { createHash, randomBytes } from 'crypto';

const AUTH_ENDPOINT = 'https://oauth.telegram.org/auth';
const TOKEN_ENDPOINT = 'https://oauth.telegram.org/token';
const ISSUER = 'https://oauth.telegram.org';
const SCOPE = 'openid profile';
const STATE_TTL_MS = 10 * 60 * 1000; // browser must complete login within 10 min

interface PendingAuth {
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

// In-memory CSRF/PKCE state, keyed by `state`. Single app instance (host
// network, one container), so in-memory is fine.
const pending = new Map<string, PendingAuth>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > STATE_TTL_MS) pending.delete(k);
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isConfigured(): boolean {
  return !!(process.env.TELEGRAM_OIDC_CLIENT_ID && process.env.TELEGRAM_OIDC_CLIENT_SECRET);
}

/** Build the authorization URL and remember the PKCE verifier for this state. */
export function buildAuthUrl(redirectUri: string): string {
  sweep();
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  pending.set(state, { verifier, redirectUri, createdAt: Date.now() });

  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set('client_id', process.env.TELEGRAM_OIDC_CLIENT_ID!);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface OidcProfile {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
}

function decodeJwtPayload(token: string): any {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Malformed id_token');
  const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

/**
 * Exchange the authorization code for an id_token and return the Telegram
 * profile. Consumes the one-time `state` (single-use, defends against replay).
 */
export async function exchangeCode(code: string, state: string): Promise<OidcProfile> {
  const entry = pending.get(state);
  if (!entry) throw new Error('Invalid or expired login state');
  pending.delete(state);

  const clientId = process.env.TELEGRAM_OIDC_CLIENT_ID!;
  const clientSecret = process.env.TELEGRAM_OIDC_CLIENT_SECRET!;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: entry.redirectUri,
    client_id: clientId,
    code_verifier: entry.verifier,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: ${res.status} ${t.slice(0, 200)}`);
  }

  const tokenResponse: any = await res.json();
  const idToken: string | undefined = tokenResponse?.id_token;
  if (!idToken) throw new Error('No id_token in token response');

  const claims = decodeJwtPayload(idToken);
  if (claims.iss !== ISSUER) throw new Error('Bad id_token issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.map(String).includes(String(clientId))) throw new Error('Bad id_token audience');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) {
    throw new Error('id_token expired');
  }

  const id = Number(claims.id ?? claims.sub);
  if (!Number.isFinite(id) || id <= 0) throw new Error('id_token missing Telegram user id');

  const name: string = (claims.name || '').trim();
  const [first, ...rest] = name ? name.split(/\s+/) : [];
  const username: string | undefined = (claims.preferred_username || '').replace(/^@/, '') || undefined;

  return {
    id,
    username,
    first_name: first || undefined,
    last_name: rest.length ? rest.join(' ') : undefined,
    photo_url: claims.picture || undefined,
  };
}
