import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
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

describe('loginWithTelegram replay window', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'fake-bot-token-1234567890';
    process.env.JWT_SECRET = 'a'.repeat(64);
  });

  test('rejects payloads older than 300 seconds', async () => {
    const { loginWithTelegram } = await import('./auth-service');
    // Build a payload with a stale auth_date (10 minutes ago)
    const old = Math.floor(Date.now() / 1000) - 600;
    const payload = { id: 1, first_name: 'X', auth_date: old, hash: 'doesntmatter' };
    await expect(loginWithTelegram(payload as any))
      .rejects.toThrow(/expired|Invalid/);
  });

  test('rejects payloads older than 5 minutes but younger than 24 hours', async () => {
    const { loginWithTelegram } = await import('./auth-service');
    // 10 minutes ago — well inside the old 24h window, well outside the new 5m window
    const stale = Math.floor(Date.now() / 1000) - 600;
    const payload = { id: 1, first_name: 'X', auth_date: stale, hash: 'doesntmatter' };
    await expect(loginWithTelegram(payload as any))
      .rejects.toThrow(/expired|Invalid/);
  });
});

describe('whitelist dual-mode (telegram_id + username fallback)', () => {
  test('locks username row to telegram_id on first successful login', async () => {
    const lockSpy = mock(async (_username: string, _telegramId: number) => {});
    const isAllowedByIdSpy = mock(async (_telegramId: number) => false);
    const isAllowedByUsernameSpy = mock(async (_username: string) => true);

    mock.module('../db/cabinets-repository', () => ({
      isUserAllowedByTelegramId: isAllowedByIdSpy,
      isUserAllowed: isAllowedByUsernameSpy,
      lockAllowedUserToTelegramId: lockSpy,
      getAccountsForUser: mock(async () => []),
      getCabinetsForUser: mock(async () => []),
      getAllAccounts: mock(async () => []),
      addUserToAccount: mock(async () => {}),
      getCabinetById: mock(async () => null),
      userHasAccessToCabinet: mock(async () => false),
    }));

    process.env.TELEGRAM_BOT_TOKEN = 'fake-bot-token-1234567890';
    process.env.JWT_SECRET = 'a'.repeat(64);

    const { _checkWhitelistForTests } = await import('./auth-service');
    const ok = await _checkWhitelistForTests({ id: 555, username: 'bob' });
    expect(ok).toBe(true);
    expect(lockSpy).toHaveBeenCalledWith('bob', 555);
  });

  test('rejects when neither telegram_id nor username matches', async () => {
    mock.module('../db/cabinets-repository', () => ({
      isUserAllowedByTelegramId: mock(async () => false),
      isUserAllowed: mock(async () => false),
      lockAllowedUserToTelegramId: mock(async () => {}),
      getAccountsForUser: mock(async () => []),
      getCabinetsForUser: mock(async () => []),
      getAllAccounts: mock(async () => []),
      addUserToAccount: mock(async () => {}),
      getCabinetById: mock(async () => null),
      userHasAccessToCabinet: mock(async () => false),
    }));

    const { _checkWhitelistForTests } = await import('./auth-service');
    const ok = await _checkWhitelistForTests({ id: 999, username: 'nope' });
    expect(ok).toBe(false);
  });

  test('telegram_id match alone is sufficient (no username required)', async () => {
    const lockSpy = mock(async () => {});
    mock.module('../db/cabinets-repository', () => ({
      isUserAllowedByTelegramId: mock(async () => true),
      isUserAllowed: mock(async () => false),
      lockAllowedUserToTelegramId: lockSpy,
      getAccountsForUser: mock(async () => []),
      getCabinetsForUser: mock(async () => []),
      getAllAccounts: mock(async () => []),
      addUserToAccount: mock(async () => {}),
      getCabinetById: mock(async () => null),
      userHasAccessToCabinet: mock(async () => false),
    }));

    const { _checkWhitelistForTests } = await import('./auth-service');
    const ok = await _checkWhitelistForTests({ id: 1234 });
    expect(ok).toBe(true);
    expect(lockSpy).not.toHaveBeenCalled();
  });
});
