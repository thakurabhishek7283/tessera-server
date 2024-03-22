import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { testApp } from './helpers.js';

let app: Awaited<ReturnType<typeof testApp>>;
afterEach(async () => app.close());

describe('OpenAPI', () => {
  it('documents every REST route from the zod schemas', async () => {
    app = await testApp();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json<{
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, { tags?: string[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    }>();

    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info).toMatchObject({ title: 'tessera-server', version: VERSION });
    expect(spec.components.securitySchemes).toHaveProperty('bearer');

    const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(operations).toEqual(
      expect.arrayContaining([
        'GET /health',
        'POST /v1/auth/guest',
        'GET /v1/ice',
        'GET /v1/docs/{appId}/{collection}',
        'GET /v1/docs/{appId}/{collection}/{id}',
        'PUT /v1/docs/{appId}/{collection}/{id}',
        'DELETE /v1/docs/{appId}/{collection}/{id}',
        'POST /v1/uploads/{appId}',
        'GET /v1/chat/{appId}/conversations/{id}/messages',
      ]),
    );
  });

  it('describes query parameters and request bodies', async () => {
    app = await testApp();
    const spec = (await app.inject({ method: 'GET', url: '/docs/json' })).json<{
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name: string }>; requestBody?: unknown }>
      >;
    }>();
    const list = spec.paths['/v1/docs/{appId}/{collection}']?.get;
    expect(list?.parameters?.map((p) => p.name)).toEqual(
      expect.arrayContaining(['appId', 'collection', 'orderBy', 'dir', 'limit', 'cursor']),
    );
    expect(spec.paths['/v1/docs/{appId}/{collection}/{id}']?.put?.requestBody).toBeDefined();
  });

  it('serves the interactive UI', async () => {
    app = await testApp();
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect([200, 302]).toContain(res.statusCode);
    const page =
      res.statusCode === 302
        ? await app.inject({ method: 'GET', url: String(res.headers.location) })
        : res;
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toMatch(/swagger/i);
    expect(String(page.headers['content-security-policy'])).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('is absent when ENABLE_DOCS=false', async () => {
    app = await testApp({ ENABLE_DOCS: 'false' });
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
