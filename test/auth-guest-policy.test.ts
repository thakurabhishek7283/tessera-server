import { GuestAuthRes } from '@tessera/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthorizer, parseRoom } from '../src/auth/policy.js';
import type { AuthUser } from '../src/auth/verifier.js';
import { openDatabase } from '../src/db/client.js';
import { conversationMembers, conversations } from '../src/db/schema.js';
import { testApp, testEnv } from './helpers.js';

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 'u1',
  name: 'Ada',
  anonymous: false,
  apps: null,
  ...over,
});

describe('POST /v1/auth/guest', () => {
  let app: Awaited<ReturnType<typeof testApp>>;
  afterEach(async () => app.close());

  it('issues a token the verifier accepts', async () => {
    app = await testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: { name: 'Ada' },
    });
    expect(res.statusCode).toBe(200);
    const body = GuestAuthRes.parse(res.json());
    expect(body.user.name).toBe('Ada');
    expect(body.user.id).toMatch(/^guest-/);
    await expect(app.verifier.verify(body.token)).resolves.toMatchObject({ id: body.user.id });
  });

  it('rejects an empty name with the error envelope', async () => {
    app = await testApp();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('is not available outside dev mode', async () => {
    app = await testApp({ AUTH_MODE: 'secret', JWT_SECRET: 'x'.repeat(32) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: { name: 'Ada' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('respects custom claim names', async () => {
    app = await testApp({ JWT_CLAIM_USER_ID: 'uid', JWT_CLAIM_NAME: 'display' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: { name: 'Bo' },
    });
    const body = GuestAuthRes.parse(res.json());
    expect(body.user.name).toBe('Bo');
  });
});

describe('authorizer', () => {
  it('parses room names', () => {
    expect(parseRoom('shop/chat:dm:abc')).toEqual({ appId: 'shop', kind: 'chat', id: 'dm:abc' });
    expect(parseRoom('nonsense')).toBeNull();
  });

  it('limits tokens to their app allowlist', () => {
    const db = openDatabase(':memory:');
    const authz = createAuthorizer(testEnv(), db);
    const limited = user({ apps: ['shop'] });
    expect(authz.canAccessApp(limited, 'shop')).toBe(true);
    expect(authz.canAccessApp(limited, 'blog')).toBe(false);
    expect(authz.canJoin(limited, 'blog/chat:general')).toBe(false);
    expect(authz.canRead(limited, 'blog', 'x')).toBe(false);
    expect(authz.canAccessApp(user(), 'anything')).toBe(true);
    db.close();
  });

  it('keeps direct-message rooms private to their members', () => {
    const db = openDatabase(':memory:');
    db.orm
      .insert(conversations)
      .values({ id: 'dm:1', appId: 'shop', kind: 'direct', createdAt: 't', createdBy: 'u1' })
      .run();
    db.orm
      .insert(conversationMembers)
      .values({ conversationId: 'dm:1', userId: 'u1', joinedAt: 't' })
      .run();
    const authz = createAuthorizer(testEnv(), db);
    expect(authz.canJoin(user({ id: 'u1' }), 'shop/chat:dm:1')).toBe(true);
    expect(authz.canJoin(user({ id: 'u2' }), 'shop/chat:dm:1')).toBe(false);
    expect(authz.canJoin(user({ id: 'u2' }), 'shop/chat:dm:missing')).toBe(false);
    expect(authz.canJoin(user({ id: 'u2' }), 'shop/chat:general')).toBe(true);
    db.close();
  });

  it('lets anonymous guests write only in dev mode', () => {
    const db = openDatabase(':memory:');
    const guest = user({ anonymous: true });
    expect(createAuthorizer(testEnv(), db).canWrite(guest, 'a', 'c')).toBe(true);
    const strict = testEnv({ AUTH_MODE: 'secret', JWT_SECRET: 'x'.repeat(32) });
    expect(createAuthorizer(strict, db).canWrite(guest, 'a', 'c')).toBe(false);
    expect(createAuthorizer(strict, db).canWrite(user(), 'a', 'c')).toBe(true);
    db.close();
  });
});
