import { createHmac, createHash, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import * as usersRepo from '../db/users-repository';
import * as cabinetsRepo from '../db/cabinets-repository';
import type { DBUser } from '../db/users-repository';

export interface TelegramAuthData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface JWTPayload {
  userId: number;
  telegramId: number;
  role: string;
}

export interface AuthResponse {
  access_token: string;
  expires_at: string;
  user: DBUser;
}

const JWT_SECRET = process.env.JWT_SECRET || '';

/**
 * Hard-fail at startup if JWT_SECRET is missing, default, or weak.
 *
 * By default validates the module constant `JWT_SECRET` — the same value
 * signToken/verifyToken use. The optional `value` parameter exists for tests
 * so they can cover failure modes without mutating process.env (which would
 * be a no-op because Bun caches the module after first import and the
 * `JWT_SECRET` constant is frozen at that point).
 *
 * Called from src/index.ts before Bun.serve starts. We do NOT throw at
 * import time so tests can load the module to mock other pieces.
 */
export function assertJwtSecretConfigured(value: string = JWT_SECRET): void {
  if (!value) {
    throw new Error('JWT_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to .env.');
  }
  if (value === 'change-me-in-production') {
    throw new Error('JWT_SECRET is still the default placeholder. Replace it with a real secret.');
  }
  if (value.length < 32) {
    throw new Error(`JWT_SECRET must be at least 32 characters (got ${value.length}). Use \`openssl rand -hex 32\`.`);
  }
}
const JWT_ACCESS_TTL = process.env.JWT_ACCESS_TTL || '24h';

export function verifyTelegramAuth(data: TelegramAuthData): boolean {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!TELEGRAM_BOT_TOKEN) return false;

  const params: string[] = [];
  if (data.auth_date) params.push(`auth_date=${data.auth_date}`);
  if (data.first_name) params.push(`first_name=${data.first_name}`);
  if (data.id) params.push(`id=${data.id}`);
  if (data.last_name) params.push(`last_name=${data.last_name}`);
  if (data.photo_url) params.push(`photo_url=${data.photo_url}`);
  if (data.username) params.push(`username=${data.username}`);

  params.sort();
  const dataCheckString = params.join('\n');

  const secretKey = createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const expectedHex = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Constant-time comparison. The length guard ensures timingSafeEqual's
  // equal-length precondition is met without branching on the secret. The
  // try/catch below guards Buffer.from(..., 'hex') for the malformed-input
  // case — Buffer.from throws on invalid hex; timingSafeEqual itself can't
  // throw once the length check has passed.
  if (!data.hash || data.hash.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(data.hash, 'hex'));
  } catch {
    return false;
  }
}

export async function loginWithTelegram(data: TelegramAuthData): Promise<AuthResponse> {
  if (!verifyTelegramAuth(data)) {
    throw new Error('Invalid Telegram auth data');
  }

  // Check auth_date is not too old (allow 1 day)
  const now = Math.floor(Date.now() / 1000);
  if (now - data.auth_date > 86400) {
    throw new Error('Telegram auth data expired');
  }

  // Whitelist check via DB
  if (!data.username || !(await cabinetsRepo.isUserAllowed(data.username))) {
    throw new Error('Access denied: your account is not whitelisted');
  }

  let user = await usersRepo.getUserByTelegramId(data.id);

  if (user) {
    await usersRepo.updateUser(data.id, {
      username: data.username,
      first_name: data.first_name,
      last_name: data.last_name,
      photo_url: data.photo_url,
    });
    user = (await usersRepo.getUserByTelegramId(data.id))!;
  } else {
    user = await usersRepo.createUser({
      telegram_id: data.id,
      username: data.username,
      first_name: data.first_name,
      last_name: data.last_name,
      photo_url: data.photo_url,
    });
  }

  // Auto-create default account+cabinet association if user has none
  const accounts = await cabinetsRepo.getAccountsForUser(user.id);
  if (accounts.length === 0) {
    // Find first available account (or create one)
    const allAccounts = await cabinetsRepo.getAllAccounts();
    if (allAccounts.length > 0) {
      await cabinetsRepo.addUserToAccount(user.id, allAccounts[0].id, 'member');
    }
  }

  return generateAuthResponse(user);
}

export function generateAuthResponse(user: DBUser): AuthResponse {
  const payload: JWTPayload = {
    userId: user.id,
    telegramId: user.telegram_id,
    role: user.role,
  };

  const expiresInSeconds = parseExpiry(JWT_ACCESS_TTL);
  const access_token = jwt.sign(payload, JWT_SECRET, { expiresIn: expiresInSeconds });
  const decoded = jwt.decode(access_token) as jwt.JwtPayload;

  return {
    access_token,
    expires_at: new Date((decoded.exp || 0) * 1000).toISOString(),
    user,
  };
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

function parseExpiry(ttl: string): number {
  const match = ttl.match(/^(\d+)(h|m|d|s)?$/);
  if (!match) return 86400;
  const val = parseInt(match[1]!);
  switch (match[2]) {
    case 'h': return val * 3600;
    case 'm': return val * 60;
    case 'd': return val * 86400;
    default: return val;
  }
}

export async function getCurrentUser(userId: number): Promise<DBUser | null> {
  return usersRepo.getUserById(userId);
}
