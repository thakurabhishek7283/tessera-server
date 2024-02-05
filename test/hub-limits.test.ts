import { afterEach, describe, expect, it } from 'vitest';
import { KeyedRateLimiter, TokenBucket } from '../src/lib/ratelimit.js';
import { connect, startTestServer, type TestServer, wsClient } from './ws.js';

let server: TestServer;
const stopServer = () => afterEach(async () => server.close());

describe('TokenBucket', () => {
  it('allows a burst, refuses beyond it and refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 2, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now += 500; // 1 token at 2/s
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now += 60_000;
    expect(bucket.idle).toBe(true);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('KeyedRateLimiter', () => {
  it('limits keys independently and forgets idle ones', () => {
    let now = 0;
    const limiter = new KeyedRateLimiter(() => now);
    expect(limiter.take('a', 1, 1)).toBe(true);
    expect(limiter.take('a', 1, 1)).toBe(false);
    expect(limiter.take('b', 1, 1)).toBe(true);
    expect(limiter.size).toBe(2);
    now += 5000;
    limiter.prune();
    expect(limiter.size).toBe(0);
  });
});

describe('connection rate limit', () => {
  stopServer();

  it('drops frames beyond the burst with RATE_LIMITED errors', async () => {
    server = await startTestServer({}, { hub: { bucketCapacity: 5, bucketRefillPerSecond: 1 } });
    const c = await connect(server); // hello used one token
    for (let i = 0; i < 10; i++) c.send({ t: 'ping', ts: i });
    await c.waitFor(() => c.of('error').length === 6);
    expect(c.of('pong')).toHaveLength(4);
    expect(c.of('error').every((e) => e.error.code === 'RATE_LIMITED')).toBe(true);
    c.close();
  });

  it('fails a throttled request with a res so the caller does not wait for a timeout', async () => {
    server = await startTestServer({}, { hub: { bucketCapacity: 2, bucketRefillPerSecond: 1 } });
    const c = await connect(server);
    c.send({ t: 'join', id: 'j', room: 'shop/chat:general' });
    c.send({ t: 'req', id: 'r1', room: 'shop/chat:general', topic: 'chat.history', data: {} });
    expect(await c.waitFor((m) => m.t === 'res' && m.id === 'r1')).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    c.close();
  });

  it('fails a throttled join with an error that references the join id', async () => {
    server = await startTestServer({}, { hub: { bucketCapacity: 1, bucketRefillPerSecond: 1 } });
    const c = await connect(server); // bucket now empty
    c.send({ t: 'join', id: 'j9', room: 'shop/chat:general' });
    expect(await c.waitFor((m) => m.t === 'error')).toMatchObject({
      ref: 'j9',
      error: { code: 'RATE_LIMITED' },
    });
    c.close();
  });

  it('recovers once the bucket refills', async () => {
    server = await startTestServer({}, { hub: { bucketCapacity: 2, bucketRefillPerSecond: 50 } });
    const c = await connect(server);
    c.send({ t: 'ping', ts: 1 });
    c.send({ t: 'ping', ts: 2 });
    await c.waitFor(() => c.of('error').length === 1);
    await new Promise((r) => setTimeout(r, 120));
    c.send({ t: 'ping', ts: 3 });
    await c.waitFor((m) => m.t === 'pong' && m.ts === 3);
    c.close();
  });

  it('does not close the connection for rate-limited frames', async () => {
    server = await startTestServer({}, { hub: { bucketCapacity: 3, bucketRefillPerSecond: 1 } });
    const c = await connect(server);
    for (let i = 0; i < 30; i++) c.send({ t: 'ping', ts: i });
    await c.waitFor(() => c.of('error').length >= 20);
    expect(c.ws.readyState).toBe(1);
    c.close();
  });
});

describe('heartbeat', () => {
  stopServer();

  const fast = { heartbeatIntervalMs: 40, pongTimeoutMs: 80 };

  it('pings authenticated connections and keeps those that answer', async () => {
    server = await startTestServer({}, { hub: fast });
    const c = await connect(server);
    let pings = 0;
    c.ws.on('ping', () => pings++);
    await expect.poll(() => pings, { timeout: 1000 }).toBeGreaterThanOrEqual(3);
    expect(c.ws.readyState).toBe(1);
    expect(server.app.hub.connectionCount).toBe(1);
    c.close();
  });

  it('terminates a connection that stops answering pings and clears its rooms', async () => {
    server = await startTestServer({}, { hub: fast });
    const alive = await connect(server);
    const silent = await wsClient(server.url, { autoPong: false });
    silent.send({ t: 'hello', v: 1, token: null, appId: 'shop' });
    const welcome = await silent.waitFor((m) => m.t === 'welcome');
    for (const c of [alive, silent]) {
      c.send({ t: 'join', id: 'j', room: 'shop/presence:app' });
      await c.waitFor((m) => m.t === 'joined');
    }
    expect(await silent.closed).toBe(1006);
    expect(await alive.waitFor((m) => m.t === 'peer-leave')).toMatchObject({
      peerId: (welcome as { peerId: string }).peerId,
    });
    expect(server.app.hub.connectionCount).toBe(1);
    alive.close();
  });
});
