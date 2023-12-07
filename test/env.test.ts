import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../src/env.js';

describe('parseEnv', () => {
  it('applies documented defaults', () => {
    const env = parseEnv({});
    expect(env).toMatchObject({
      port: 8787,
      host: '0.0.0.0',
      authMode: 'dev',
      callMaxParticipants: 6,
      uploadMaxBytes: 5 * 1024 * 1024,
      turnTtlSeconds: 3600,
      stunUrls: ['stun:stun.l.google.com:19302'],
      turnUrls: [],
    });
    expect(env.claims).toEqual({
      userId: 'sub',
      name: 'name',
      avatar: 'picture',
      roles: 'roles',
      apps: 'tessera_apps',
    });
  });

  it('splits comma lists and trims blanks', () => {
    const env = parseEnv({
      CORS_ORIGINS: ' http://a.test , http://b.test ,',
      UPLOAD_ALLOWED: 'image/png, application/pdf',
    });
    expect(env.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    expect(env.uploadAllowed).toEqual(['image/png', 'application/pdf']);
  });

  it('treats blank values as unset', () => {
    const env = parseEnv({ JWKS_URL: '', TURN_URLS: '', PORT: '' });
    expect(env.jwksUrl).toBeUndefined();
    expect(env.port).toBe(8787);
  });

  it('strips trailing slashes from PUBLIC_URL', () => {
    expect(parseEnv({ PUBLIC_URL: 'https://api.example.com//' }).publicUrl).toBe(
      'https://api.example.com',
    );
  });

  it('allows a wildcard CORS origin only in dev mode', () => {
    expect(parseEnv({ CORS_ORIGINS: '*' }).corsOrigins).toEqual(['*']);
    expect(() =>
      parseEnv({ AUTH_MODE: 'secret', JWT_SECRET: 'x'.repeat(32), CORS_ORIGINS: '*' }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('requires a 32+ character secret in secret mode', () => {
    expect(() => parseEnv({ AUTH_MODE: 'secret', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(parseEnv({ AUTH_MODE: 'secret', JWT_SECRET: 'x'.repeat(32) }).authMode).toBe('secret');
  });

  it('requires JWKS_URL in jwks mode', () => {
    expect(() => parseEnv({ AUTH_MODE: 'jwks' })).toThrow(/JWKS_URL/);
    expect(
      parseEnv({ AUTH_MODE: 'jwks', JWKS_URL: 'https://id.example.com/.well-known/jwks.json' })
        .jwksUrl,
    ).toBe('https://id.example.com/.well-known/jwks.json');
  });

  it('requires TURN_SECRET when TURN_URLS is set', () => {
    expect(() => parseEnv({ TURN_URLS: 'turn:turn.example.com:3478' })).toThrow(/TURN_SECRET/);
  });

  it('lists every problem in one error', () => {
    try {
      parseEnv({ PORT: 'abc', LOG_LEVEL: 'loud' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).problems).toHaveLength(2);
      expect((err as Error).message).toMatch(/PORT/);
      expect((err as Error).message).toMatch(/LOG_LEVEL/);
    }
  });
});
