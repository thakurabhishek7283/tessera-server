import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, connect, startTestServer, type TestServer, type WsClient } from './ws.js';

let server: TestServer;
afterEach(async () => server.close());

type Peer = WsClient & { peerId: string };
const ROOM = 'shop/call:x';

const join = async (c: Peer, room = ROOM) => {
  c.send({ t: 'join', id: `j-${room}`, room });
  await c.waitFor((m) => m.t === 'joined' && m.id === `j-${room}`);
};

const trio = async () => {
  const [a, b, c] = [await connect(server), await connect(server), await connect(server)];
  for (const p of [a, b, c]) await join(p);
  return { a, b, c };
};

/** Round-trips a ping so every frame sent before it has been processed. */
const settle = async (c: Peer) => {
  const ts = Math.random();
  c.send({ t: 'ping', ts });
  await c.waitFor((m) => m.t === 'pong' && m.ts === ts);
};

describe('pub', () => {
  it('fans out to the other peers, tagged with the sender, never back to the sender', async () => {
    server = await startTestServer();
    const { a, b, c } = await trio();
    a.send({ t: 'pub', room: ROOM, topic: 'chat.typing', data: { on: true } });
    const [mb, mc] = await Promise.all([
      b.waitFor((m) => m.t === 'msg'),
      c.waitFor((m) => m.t === 'msg'),
    ]);
    for (const m of [mb, mc]) {
      expect(m).toMatchObject({
        room: ROOM,
        topic: 'chat.typing',
        data: { on: true },
        from: a.peerId,
        ts: expect.any(Number),
      });
    }
    await settle(a);
    expect(a.of('msg')).toEqual([]);
    closeAll(a, b, c);
  });

  it('does not leak into other rooms', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(a);
    await join(b, 'shop/call:other');
    a.send({ t: 'pub', room: ROOM, topic: 'x.y', data: 1 });
    await settle(b);
    expect(b.of('msg')).toEqual([]);
    closeAll(a, b);
  });

  it('refuses publishing to a room you have not joined', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(b);
    a.send({ t: 'pub', room: ROOM, topic: 'x.y', data: 1 });
    expect(await a.waitFor((m) => m.t === 'error')).toMatchObject({
      error: { code: 'FORBIDDEN', details: { reason: 'not-in-room' } },
    });
    await settle(b);
    expect(b.of('msg')).toEqual([]);
    closeAll(a, b);
  });

  it('blocks server-only topics so messages cannot be forged', async () => {
    server = await startTestServer();
    const { a, b, c } = await trio();
    for (const topic of [
      'chat.message',
      'chat.message-updated',
      'chat.reaction',
      'chat.read',
      'doc.changed',
    ]) {
      a.send({ t: 'pub', room: ROOM, topic, data: {} });
    }
    a.send({ t: 'direct', room: ROOM, to: b.peerId, topic: 'chat.message', data: {} });
    await a.waitFor(() => a.of('error').length === 6);
    expect(
      a
        .of('error')
        .every(
          (e) =>
            e.error.details && (e.error.details as { reason: string }).reason === 'reserved-topic',
        ),
    ).toBe(true);
    await settle(b);
    await settle(c);
    expect(b.of('msg')).toEqual([]);
    expect(c.of('msg')).toEqual([]);
    closeAll(a, b, c);
  });

  it('ignores a client-supplied "from"', async () => {
    server = await startTestServer();
    const { a, b, c } = await trio();
    a.send({ t: 'pub', room: ROOM, topic: 'x.y', data: 1, from: 'server' });
    expect(await b.waitFor((m) => m.t === 'msg')).toMatchObject({ from: a.peerId });
    closeAll(a, b, c);
  });
});

describe('direct', () => {
  it('delivers to the target only', async () => {
    server = await startTestServer();
    const { a, b, c } = await trio();
    a.send({ t: 'direct', room: ROOM, to: b.peerId, topic: 'rtc.signal', data: { sdp: 'offer' } });
    expect(await b.waitFor((m) => m.t === 'msg')).toMatchObject({
      topic: 'rtc.signal',
      data: { sdp: 'offer' },
      from: a.peerId,
    });
    await settle(c);
    await settle(a);
    expect(c.of('msg')).toEqual([]);
    expect(a.of('msg')).toEqual([]);
    closeAll(a, b, c);
  });

  it('answers NOT_FOUND for unknown peers and peers outside the room', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const outsider = await connect(server);
    await join(a);
    await join(outsider, 'shop/call:other');
    a.send({ t: 'direct', room: ROOM, to: 'p_missing', topic: 'rtc.signal', data: 1 });
    a.send({ t: 'direct', room: ROOM, to: outsider.peerId, topic: 'rtc.signal', data: 1 });
    await a.waitFor(() => a.of('error').length === 2);
    expect(a.of('error').every((e) => e.error.code === 'NOT_FOUND')).toBe(true);
    await settle(outsider);
    expect(outsider.of('msg')).toEqual([]);
    closeAll(a, outsider);
  });

  it('requires the sender to be in the room', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(b);
    a.send({ t: 'direct', room: ROOM, to: b.peerId, topic: 'rtc.signal', data: 1 });
    expect(await a.waitFor((m) => m.t === 'error')).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await settle(b);
    expect(b.of('msg')).toEqual([]);
    closeAll(a, b);
  });
});

describe('server broadcast', () => {
  it('reaches every peer with from "server"', async () => {
    server = await startTestServer();
    const { a, b, c } = await trio();
    server.app.hub.broadcast(ROOM, 'doc.changed', { collection: 'c', id: '1', version: 2 });
    for (const p of [a, b, c]) {
      expect(await p.waitFor((m) => m.t === 'msg')).toMatchObject({
        topic: 'doc.changed',
        from: 'server',
        data: { id: '1' },
      });
    }
    closeAll(a, b, c);
  });
});
