import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createHash, createHmac } from 'crypto';
import { assertJwtSecretConfigured } from './auth-service';

describe('assertJwtSecretConfigured', () => {
  test('throws when JWT_SECRET is empty', () => {
    expect(() => assertJwtSecretConfigured('')).toThrow(/JWT_SECRET/);
  });

  test('throws when JWT_SECRET equals the placeholder', () => {
    expect(() => assertJwtSecretConfigured('change-me-in-production')).toThrow(/JWT_SECRET/);
  });

  test('throws when JWT_SECRET is shorter than 32 characters', () => {
    expect(() => assertJwtSecretConfigured('too-short')).toThrow(/JWT_SECRET/);
  });

  test('passes when JWT_SECRET is a strong 64-char value', () => {
    expect(() => assertJwtSecretConfigured('a'.repeat(64))).not.toThrow();
  });

  test('passes when JWT_SECRET is exactly 32 characters', () => {
    expect(() => assertJwtSecretConfigured('b'.repeat(32))).not.toThrow();
  });
});

describe('verifyTelegramAuth', () => {
  const BOT_TOKEN = 'fake-bot-token-1234567890';
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  });

  function makeAuthData(overrides: Record<string, any> = {}) {
    const base: Record<string, any> = {
      auth_date: Math.floor(Date.now() / 1000),
      first_name: 'Alice',
      id: 999,
      username: 'alice',
      ...overrides,
    };
    const params = Object.keys(base)
      .sort()
      .map(k => `${k}=${base[k]}`)
      .join('\n');
    const secret = createHash('sha256').update(BOT_TOKEN).digest();
    base.hash = createHmac('sha256', secret).update(params).digest('hex');
    return base;
  }

  test('accepts a valid HMAC', async () => {
    const { verifyTelegramAuth } = await import('./auth-service');
    expect(verifyTelegramAuth(makeAuthData() as any)).toBe(true);
  });

  test('rejects a tampered HMAC', async () => {
    const { verifyTelegramAuth } = await import('./auth-service');
    const data = makeAuthData() as any;
    data.hash = 'a'.repeat(data.hash.length);
    expect(verifyTelegramAuth(data)).toBe(false);
  });

  test('rejects a hash of different length without throwing', async () => {
    const { verifyTelegramAuth } = await import('./auth-service');
    const data = makeAuthData() as any;
    data.hash = 'short';
    expect(verifyTelegramAuth(data)).toBe(false);
  });

  test('returns false when TELEGRAM_BOT_TOKEN is unset', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { verifyTelegramAuth } = await import('./auth-service');
    expect(verifyTelegramAuth(makeAuthData() as any)).toBe(false);
  });
});
