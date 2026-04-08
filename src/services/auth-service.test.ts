import { test, expect, describe, beforeEach, afterEach } from 'bun:test';

describe('JWT_SECRET startup check', () => {
  let originalSecret: string | undefined;
  beforeEach(() => { originalSecret = process.env.JWT_SECRET; });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  test('throws when JWT_SECRET is unset', async () => {
    delete process.env.JWT_SECRET;
    const { assertJwtSecretConfigured } = await import('./auth-service');
    expect(() => assertJwtSecretConfigured()).toThrow(/JWT_SECRET/);
  });

  test('throws when JWT_SECRET equals the placeholder', async () => {
    process.env.JWT_SECRET = 'change-me-in-production';
    const { assertJwtSecretConfigured } = await import('./auth-service');
    expect(() => assertJwtSecretConfigured()).toThrow(/JWT_SECRET/);
  });

  test('throws when JWT_SECRET is shorter than 32 characters', async () => {
    process.env.JWT_SECRET = 'too-short';
    const { assertJwtSecretConfigured } = await import('./auth-service');
    expect(() => assertJwtSecretConfigured()).toThrow(/JWT_SECRET/);
  });

  test('passes when JWT_SECRET is a strong value', async () => {
    process.env.JWT_SECRET = 'a'.repeat(64);
    const { assertJwtSecretConfigured } = await import('./auth-service');
    expect(() => assertJwtSecretConfigured()).not.toThrow();
  });
});
