import { createHmac } from 'node:crypto';
import { IceRes } from '@tessera-kit/protocol';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { buildIceServers, turnCredentials } from '../src/modules/ice/routes.js';
import { bearer, guest, testApp, testEnv } from './helpers.js';

let app: Awaited<ReturnType<typeof testApp>>;

describe('turnCredentials', () => {
  it('follows the coturn REST scheme: <expiry>:<user> with an HMAC-SHA1 credential', () => {
    const { username, credential } = turnCredentials('s3cret', 'ada', 1_700_000_000_000, 3600);
    expect(username).toBe('1700003600:ada');
    expect(credential).toBe(createHmac('sha1', 's3cret').update('1700003600:ada').digest('base64'));
    // Independent vector computed with Python's hmac module.
    expect(credential).toBe('Py4eM5SHz6wyBpurwH/r6N9jcbo=');
  });

  it('changes with the secret, the user and the time', () => {
    const base = turnCredentials('a', 'u', 0, 60).credential;
    expect(turnCredentials('b', 'u', 0, 60).credential).not.toBe(base);
    expect(turnCredentials('a', 'v', 0, 60).credential).not.toBe(base);
    expect(turnCredentials('a', 'u', 1000, 60).credential).not.toBe(base);
  });
});

describe('buildIceServers', () => {
  it('returns only STUN when TURN is not configured', () => {
    const env = testEnv({ STUN_URLS: 'stun:a.test:3478,stun:b.test:3478' });
    expect(buildIceServers(env, 'u', 0)).toEqual([
      { urls: ['stun:a.test:3478', 'stun:b.test:3478'] },
    ]);
  });

  it('adds TURN with credentials for the user', () => {
    const env = testEnv({
      TURN_URLS: 'turn:t.test:3478,turns:t.test:5349',
      TURN_SECRET: 'topsecret',
      TURN_TTL_SECONDS: '600',
    });
    const [stun, turn] = buildIceServers(env, 'ada', 1_000_000);
    expect(stun).toMatchObject({ urls: ['stun:stun.l.google.com:19302'] });
    expect(turn).toEqual({
      urls: ['turn:t.test:3478', 'turns:t.test:5349'],
      ...turnCredentials('topsecret', 'ada', 1_000_000, 600),
    });
    expect(turn?.username).toBe('1600:ada');
  });

  it('may be empty when nothing is configured', () => {
    expect(buildIceServers(testEnv({ STUN_URLS: ' ' }), 'u', 0)).toEqual([]);
  });
});

describe('GET /v1/ice', () => {
  afterEach(async () => app.close());

  it('returns ICE servers for the authenticated user and forbids caching', async () => {
    app = await testApp({ TURN_URLS: 'turn:t.test:3478', TURN_SECRET: 'topsecret' });
    const { token, id } = await guest(app);
    const res = await app.inject({ method: 'GET', url: '/v1/ice', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = IceRes.parse(res.json());
    expect(body.iceServers).toHaveLength(2);
    expect(body.iceServers[1]?.username).toMatch(new RegExp(`^\\d+:${id}$`));
  });

  it('issues credentials that coturn would accept and that expire on schedule', async () => {
    const now = new Date('2023-06-01T12:00:00Z');
    app = await buildApp({
      env: testEnv({
        TURN_URLS: 'turn:t.test:3478',
        TURN_SECRET: 'topsecret',
        TURN_TTL_SECONDS: '900',
      }),
      logger: false,
      clock: { now: () => now },
    });
    const { token, id } = await guest(app);
    const res = await app.inject({ method: 'GET', url: '/v1/ice', headers: bearer(token) });
    const turn = IceRes.parse(res.json()).iceServers[1];
    const expiry = Math.floor(now.getTime() / 1000) + 900;
    expect(turn?.username).toBe(`${expiry}:${id}`);
    expect(turn?.credential).toBe(
      createHmac('sha1', 'topsecret').update(`${expiry}:${id}`).digest('base64'),
    );
  });

  it('requires a valid token outside dev mode', async () => {
    app = await testApp({ AUTH_MODE: 'secret', JWT_SECRET: 's'.repeat(32) });
    expect((await app.inject({ method: 'GET', url: '/v1/ice' })).statusCode).toBe(401);
    const token = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('s'.repeat(32)));
    expect(
      (await app.inject({ method: 'GET', url: '/v1/ice', headers: bearer(token) })).statusCode,
    ).toBe(200);
  });
});
