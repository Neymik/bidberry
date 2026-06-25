import { describe, expect, it, beforeEach } from 'bun:test';

describe('telegram-oidc buildAuthUrl', () => {
  beforeEach(() => {
    process.env.TELEGRAM_OIDC_CLIENT_ID = '8298698531';
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = 'test-secret';
  });

  it('isConfigured reflects env presence', async () => {
    const oidc = await import('./telegram-oidc');
    expect(oidc.isConfigured()).toBe(true);
  });

  it('builds an oauth.telegram.org/auth URL with all required PKCE params', async () => {
    const { buildAuthUrl } = await import('./telegram-oidc');
    const redirect = 'https://bidberry.animeenigma.ru/api/auth/telegram/oidc/callback';
    const u = new URL(buildAuthUrl(redirect));

    expect(u.origin + u.pathname).toBe('https://oauth.telegram.org/auth');
    expect(u.searchParams.get('client_id')).toBe('8298698531');
    expect(u.searchParams.get('redirect_uri')).toBe(redirect);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid profile');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect((u.searchParams.get('state') || '').length).toBeGreaterThan(20);
    expect((u.searchParams.get('code_challenge') || '').length).toBeGreaterThan(20);
  });

  it('generates a fresh state + challenge on each call', async () => {
    const { buildAuthUrl } = await import('./telegram-oidc');
    const a = new URL(buildAuthUrl('https://x/cb'));
    const b = new URL(buildAuthUrl('https://x/cb'));
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
  });

  it('rejects exchange for an unknown/expired state', async () => {
    const { exchangeCode } = await import('./telegram-oidc');
    await expect(exchangeCode('somecode', 'never-issued-state')).rejects.toThrow(/state/i);
  });
});
