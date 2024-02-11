import { DocChangedEvent } from '@tessera/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryBroker } from '../src/hub/broker.js';
import { bearer, guest } from './helpers.js';
import { closeAll, connect, startTestServer, type TestServer, type WsClient } from './ws.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const start = async (...args: Parameters<typeof startTestServer>) => {
  const s = await startTestServer(...args);
  servers.push(s);
  return s;
};

type Peer = WsClient & { peerId: string };
const joinRoom = async (c: Peer, room: string) => {
  c.send({ t: 'join', id: room, room });
  await c.waitFor((m) => m.t === 'joined');
};

describe('doc.changed bridge', () => {
  it('tells docs-room members about REST writes and deletes', async () => {
    const server = await start();
    const watcher = await connect(server);
    await joinRoom(watcher, 'shop/docs:cards');
    const { token } = await guest(server.app, 'Ada');
    const headers = bearer(token);

    await server.app.inject({
      method: 'PUT',
      url: '/v1/docs/shop/cards/c1',
      headers,
      payload: { data: { a: 1 } },
    });
    await server.app.inject({ method: 'DELETE', url: '/v1/docs/shop/cards/c1', headers });
    await watcher.waitFor(() => watcher.of('msg').length === 2);

    const [created, deleted] = watcher.of('msg');
    expect(created).toMatchObject({
      room: 'shop/docs:cards',
      topic: 'doc.changed',
      from: 'server',
    });
    expect(DocChangedEvent.parse(created?.data)).toMatchObject({
      collection: 'cards',
      id: 'c1',
      version: 1,
    });
    expect(DocChangedEvent.parse(deleted?.data)).toMatchObject({
      id: 'c1',
      version: 2,
      deleted: true,
    });
    watcher.close();
  });

  it('only reaches the matching app and collection', async () => {
    const server = await start();
    const sameApp = await connect(server);
    const otherCollection = await connect(server);
    const otherApp = await connect(server, { appId: 'blog' });
    await joinRoom(sameApp, 'shop/docs:cards');
    await joinRoom(otherCollection, 'shop/docs:columns');
    await joinRoom(otherApp, 'blog/docs:cards');

    await server.app.inject({
      method: 'PUT',
      url: '/v1/docs/shop/cards/c1',
      headers: bearer((await guest(server.app)).token),
      payload: { data: {} },
    });
    await sameApp.waitFor((m) => m.t === 'msg');
    for (const c of [otherCollection, otherApp]) {
      c.send({ t: 'ping', ts: 1 });
      await c.waitFor((m) => m.t === 'pong');
      expect(c.of('msg')).toEqual([]);
    }
    closeAll(sameApp, otherCollection, otherApp);
  });

  it('does not announce rejected writes', async () => {
    const server = await start();
    const watcher = await connect(server);
    await joinRoom(watcher, 'shop/docs:cards');
    const headers = bearer((await guest(server.app)).token);
    await server.app.inject({
      method: 'PUT',
      url: '/v1/docs/shop/cards/c1',
      headers,
      payload: { data: {} },
    });
    await server.app.inject({
      method: 'PUT',
      url: '/v1/docs/shop/cards/c1',
      headers: { ...headers, 'if-match': '9' },
      payload: { data: {} },
    });
    watcher.send({ t: 'ping', ts: 1 });
    await watcher.waitFor((m) => m.t === 'pong');
    expect(watcher.of('msg')).toHaveLength(1);
    watcher.close();
  });
});

describe('broker seam', () => {
  it('InMemoryBroker delivers to subscribers, honours "except" and unsubscribes', () => {
    const broker = new InMemoryBroker();
    const seen: Array<[string, string | undefined]> = [];
    const off = broker.subscribe('r', (f, except) => seen.push([f.t, except]));
    const frame = { t: 'pong', ts: 1, serverTime: 2 } as const;
    broker.publish('r', frame, 'p1');
    broker.publish('other', frame);
    off();
    broker.publish('r', frame);
    expect(seen).toEqual([['pong', 'p1']]);
  });

  it('lets two hub instances sharing a broker see each other’s room traffic', async () => {
    const broker = new InMemoryBroker();
    const one = await start({}, { broker });
    const two = await start({}, { broker });
    const a = await connect(one);
    const b = await connect(two);
    await joinRoom(a, 'shop/call:x');
    await joinRoom(b, 'shop/call:x');

    a.send({ t: 'pub', room: 'shop/call:x', topic: 'chat.typing', data: { on: true } });
    expect(await b.waitFor((m) => m.t === 'msg')).toMatchObject({
      from: a.peerId,
      data: { on: true },
    });
    closeAll(a, b);
  });
});
