import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer, wsClient } from './ws.js';

let server: TestServer;
afterEach(async () => server.close());

const hello = (over: Record<string, unknown> = {}) => ({
  t: 'hello',
  v: 1,
  token: null,
  appId: 'shop',
  ...over,
});

describe('hello handshake', () => {
  it('welcomes an anonymous guest in dev mode', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    const welcome = await c.waitFor((m) => m.t === 'welcome');
    expect(welcome).toMatchObject({
      t: 'welcome',
      v: 1,
      peerId: expect.stringMatching(/^p_/),
      user: { id: expect.stringMatching(/^guest-/) },
    });
    expect(typeof (welcome as { serverTime: number }).serverTime).toBe('number');
    expect((welcome as { user: object }).user).not.toHaveProperty('anonymous');
    c.close();
  });

  it('identifies a user from a guest token', async () => {
    server = await startTestServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      payload: { name: 'Ada' },
    });
    const { token, user } = res.json<{ token: string; user: { id: string } }>();
    const c = await wsClient(server.url);
    c.send(hello({ token }));
    const welcome = await c.waitFor((m) => m.t === 'welcome');
    expect(welcome).toMatchObject({ user: { id: user.id, name: 'Ada' } });
    c.close();
  });

  it('rejects a bad token with UNAUTHORIZED and close code 4003', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello({ token: 'garbage' }));
    const err = await c.waitFor((m) => m.t === 'error');
    expect(err).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(await c.closed).toBe(4003);
  });

  it('requires a token outside dev mode', async () => {
    server = await startTestServer({ AUTH_MODE: 'secret', JWT_SECRET: 's'.repeat(32) });
    const c = await wsClient(server.url);
    c.send(hello());
    expect(await c.closed).toBe(4003);
  });

  it('closes with 4003 when the token may not use the requested app', async () => {
    server = await startTestServer({ AUTH_MODE: 'secret', JWT_SECRET: 's'.repeat(32) });
    const token = await new SignJWT({ sub: 'u1', tessera_apps: ['blog'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('s'.repeat(32)));
    const c = await wsClient(server.url);
    c.send(hello({ token }));
    const err = await c.waitFor((m) => m.t === 'error');
    expect(err).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await c.closed).toBe(4003);
  });

  it('closes with 4001 when hello never arrives', async () => {
    server = await startTestServer({}, { hub: { helloTimeoutMs: 80 } });
    const c = await wsClient(server.url);
    expect(await c.closed).toBe(4001);
    expect(server.app.hub.connectionCount).toBe(0);
  });

  it('closes with 4008 when the first frame is not hello', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send({ t: 'ping', ts: 1 });
    const err = await c.waitFor((m) => m.t === 'error');
    expect(err).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(await c.closed).toBe(4008);
  });

  it('rejects an invalid appId', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello({ appId: 'Not Valid!' }));
    expect(await c.closed).toBe(4008);
  });

  it('rejects an unsupported protocol version', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello({ v: 2 }));
    const err = await c.waitFor((m) => m.t === 'error');
    expect(err).toMatchObject({ error: { code: 'VALIDATION' } });
    c.close();
  });

  it('refuses a second hello without dropping the connection', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    await c.waitFor((m) => m.t === 'welcome');
    c.send(hello());
    const err = await c.waitFor((m) => m.t === 'error');
    expect(err).toMatchObject({ error: { code: 'VALIDATION' } });
    c.send({ t: 'ping', ts: 7 });
    await c.waitFor((m) => m.t === 'pong');
    c.close();
  });
});

describe('frame handling', () => {
  it('answers ping with pong echoing the timestamp', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    await c.waitFor((m) => m.t === 'welcome');
    c.send({ t: 'ping', ts: 1234 });
    expect(await c.waitFor((m) => m.t === 'pong')).toMatchObject({ ts: 1234 });
    c.close();
  });

  it('reports invalid JSON and unknown frames without closing', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    await c.waitFor((m) => m.t === 'welcome');
    c.sendRaw('{not json');
    c.send({ t: 'bogus' });
    await c.waitFor(() => c.of('error').length === 2);
    expect(c.of('error').every((e) => e.error.code === 'VALIDATION')).toBe(true);
    c.send({ t: 'ping', ts: 1 });
    await c.waitFor((m) => m.t === 'pong');
    c.close();
  });

  it('rejects binary frames', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    await c.waitFor((m) => m.t === 'welcome');
    c.sendRaw(Buffer.from([1, 2, 3]));
    expect(await c.waitFor((m) => m.t === 'error')).toMatchObject({
      error: { code: 'VALIDATION' },
    });
    c.close();
  });

  it('closes with 4008 after too many invalid frames in a minute', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    await c.waitFor((m) => m.t === 'welcome');
    for (let i = 0; i < 10; i++) c.sendRaw('nope');
    expect(await c.closed).toBe(4008);
  });

  it('closes with 1009 when a frame exceeds the size limit', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    await c.waitFor((m) => m.t === 'welcome');
    c.sendRaw('x'.repeat(70 * 1024));
    expect(await c.closed).toBe(1009);
  });

  it('processes frames in order even while the token is being verified', async () => {
    server = await startTestServer();
    const c = await wsClient(server.url);
    c.send(hello());
    c.send({ t: 'ping', ts: 5 });
    await c.waitFor((m) => m.t === 'pong');
    expect(c.frames.map((f) => f.t)).toEqual(['welcome', 'pong']);
    c.close();
  });
});
