import { DocDto, PageDto } from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocChange } from '../src/lib/events.js';
import { bearer, guest, testApp } from './helpers.js';

let app: Awaited<ReturnType<typeof testApp>>;
let auth: Record<string, string>;
let changes: DocChange[];

beforeEach(async () => {
  app = await testApp();
  auth = bearer((await guest(app)).token);
  changes = [];
  app.events.onDocChanged((c) => changes.push(c));
});
afterEach(async () => app.close());

const put = (id: string, data: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'PUT',
    url: `/v1/docs/shop/cards/${id}`,
    headers: { ...auth, ...headers },
    payload: { data },
  });

describe('/v1/docs', () => {
  it('creates, reads and replaces a document', async () => {
    const created = await put('c1', { title: 'one' });
    expect(created.statusCode).toBe(200);
    expect(DocDto.parse(created.json())).toMatchObject({ id: 'c1', version: 1 });
    expect(created.headers.etag).toBe('"1"');

    const got = await app.inject({ method: 'GET', url: '/v1/docs/shop/cards/c1', headers: auth });
    expect(got.json()).toMatchObject({ data: { title: 'one' }, version: 1 });

    const replaced = await put('c1', { title: 'two' });
    expect(replaced.json()).toMatchObject({ version: 2, data: { title: 'two' } });
  });

  it('returns 404 with the error envelope for a missing document', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/docs/shop/cards/nope', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('answers 409 with the current copy when If-Match is stale', async () => {
    await put('c1', { n: 1 });
    await put('c1', { n: 2 });
    const res = await put('c1', { n: 3 }, { 'if-match': '1' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'CONFLICT' },
      current: { id: 'c1', version: 2, data: { n: 2 } },
    });
    const ok = await put('c1', { n: 3 }, { 'if-match': '"2"' });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects a malformed If-Match', async () => {
    await put('c1', {});
    const res = await put('c1', {}, { 'if-match': 'abc' });
    expect(res.statusCode).toBe(400);
  });

  it('lists with where, orderBy, dir and limit from the query string', async () => {
    await put('a', { status: 'open', rank: 3 });
    await put('b', { status: 'open', rank: 1 });
    await put('c', { status: 'closed', rank: 2 });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/docs/shop/cards?where[status]=open&orderBy=rank&dir=desc&limit=1',
      headers: auth,
    });
    const page = PageDto.parse(res.json());
    expect(page.items.map((i) => i.id)).toEqual(['a']);
    expect(page.nextCursor).toBeDefined();

    const next = await app.inject({
      method: 'GET',
      url: `/v1/docs/shop/cards?where[status]=open&orderBy=rank&dir=desc&limit=1&cursor=${page.nextCursor}`,
      headers: auth,
    });
    expect(PageDto.parse(next.json()).items.map((i) => i.id)).toEqual(['b']);
  });

  it('matches numeric and boolean filters sent as query strings', async () => {
    await put('a', { rank: 1, done: true });
    await put('b', { rank: 2, done: false });
    const byRank = await app.inject({
      method: 'GET',
      url: '/v1/docs/shop/cards?where[rank]=2',
      headers: auth,
    });
    expect(PageDto.parse(byRank.json()).items.map((i) => i.id)).toEqual(['b']);
    const byDone = await app.inject({
      method: 'GET',
      url: '/v1/docs/shop/cards?where[done]=true',
      headers: auth,
    });
    expect(PageDto.parse(byDone.json()).items.map((i) => i.id)).toEqual(['a']);
  });

  it('validates query parameters', async () => {
    for (const q of ['limit=500', 'dir=sideways', 'orderBy=a.b', 'where[a.b]=1', 'cursor=zzz']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/docs/shop/cards?${q}`,
        headers: auth,
      });
      expect(res.statusCode, q).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    }
  });

  it('soft-deletes and reports 404 afterwards', async () => {
    await put('c1', {});
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/docs/shop/cards/c1',
      headers: auth,
    });
    expect(del.json()).toEqual({ id: 'c1', version: 2 });
    const again = await app.inject({
      method: 'DELETE',
      url: '/v1/docs/shop/cards/c1',
      headers: auth,
    });
    expect(again.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/v1/docs/shop/cards', headers: auth });
    expect(PageDto.parse(list.json()).items).toEqual([]);
  });

  it('honours If-Match on delete', async () => {
    await put('c1', {});
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/docs/shop/cards/c1',
      headers: { ...auth, 'if-match': '9' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('announces writes and deletes as doc changes', async () => {
    const bo = bearer((await guest(app, 'Bo')).token);
    await app.inject({
      method: 'PUT',
      url: '/v1/docs/shop/cards/x',
      headers: bo,
      payload: { data: {} },
    });
    await app.inject({ method: 'DELETE', url: '/v1/docs/shop/cards/x', headers: bo });
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      appId: 'shop',
      event: { collection: 'cards', id: 'x', version: 1 },
    });
    expect(changes[1]?.event).toMatchObject({ version: 2, deleted: true });
  });

  it('does not announce failed writes', async () => {
    await put('c1', {});
    changes.length = 0;
    await put('c1', {}, { 'if-match': '7' });
    expect(changes).toEqual([]);
  });

  it('validates path parameters and body', async () => {
    const badApp = await app.inject({
      method: 'GET',
      url: '/v1/docs/Bad_App/cards',
      headers: auth,
    });
    expect(badApp.statusCode).toBe(400);
    const badBody = await app.inject({
      method: 'PUT',
      url: '/v1/docs/shop/cards/c1',
      headers: auth,
      payload: { nope: 1 },
    });
    expect(badBody.statusCode).toBe(400);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/docs/shop/cards',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('/v1/docs authorization', () => {
  it('requires a valid token outside dev mode', async () => {
    const strict = await testApp({ AUTH_MODE: 'secret', JWT_SECRET: 's'.repeat(32) });
    const res = await strict.inject({ method: 'GET', url: '/v1/docs/shop/cards' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    await strict.close();
  });

  it('forbids apps outside the token allowlist', async () => {
    const strict = await testApp({ AUTH_MODE: 'secret', JWT_SECRET: 's'.repeat(32) });
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ sub: 'u1', tessera_apps: ['shop'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('s'.repeat(32)));
    const ok = await strict.inject({
      method: 'GET',
      url: '/v1/docs/shop/cards',
      headers: bearer(token),
    });
    expect(ok.statusCode).toBe(200);
    const denied = await strict.inject({
      method: 'GET',
      url: '/v1/docs/blog/cards',
      headers: bearer(token),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await strict.close();
  });

  it('lets an anonymous dev user read without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/docs/shop/cards' });
    expect(res.statusCode).toBe(200);
  });
});
