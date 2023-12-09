import { HealthRes } from '@tessera/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { testApp } from './helpers.js';

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof testApp>>;
  afterEach(async () => app.close());

  it('reports ok, version and uptime', async () => {
    app = await testApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = HealthRes.parse(res.json());
    expect(body.version).toBe(VERSION);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns the error envelope for unknown routes', async () => {
    app = await testApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('allows configured CORS origins and rejects others', async () => {
    app = await testApp({ CORS_ORIGINS: 'http://app.test' });
    const ok = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://app.test' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://app.test');
    const other = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.test' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers', async () => {
    app = await testApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
