import { test, expect, describe } from 'bun:test';
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
