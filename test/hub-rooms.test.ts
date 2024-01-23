import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationMembers, conversations } from '../src/db/schema.js';
import { closeAll, connect, startTestServer, type TestServer, type WsClient } from './ws.js';

let server: TestServer;
afterEach(async () => server.close());

type Peer = WsClient & { peerId: string };

const join = async (
  c: Peer,
  room: string,
  presence?: Record<string, unknown>,
  id = `j-${room}`,
) => {
  c.send({ t: 'join', id, room, ...(presence ? { presence } : {}) });
  return c.waitFor((m) => m.t === 'joined' && m.id === id);
};

describe('join and leave', () => {
  it('joins an empty room and lists later arrivals', async () => {
    server = await startTestServer();
    const a = await connect(server);
    expect(await join(a, 'shop/presence:app', { cursor: 1 })).toMatchObject({ peers: [] });

    const b = await connect(server);
    const joined = await join(b, 'shop/presence:app', { cursor: 2 });
    expect(joined).toMatchObject({
      peers: [
        {
          peerId: a.peerId,
          presence: { cursor: 1 },
          user: { id: expect.stringMatching(/^guest-/) },
        },
      ],
    });
    expect(await a.waitFor((m) => m.t === 'peer-join')).toMatchObject({
      room: 'shop/presence:app',
      peer: { peerId: b.peerId, presence: { cursor: 2 } },
    });
    expect(b.of('peer-join')).toEqual([]);
    a.close();
    b.close();
  });

  it('announces leave and removes the peer from later joins', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(a, 'shop/presence:app');
    await join(b, 'shop/presence:app');
    b.send({ t: 'leave', room: 'shop/presence:app' });
    expect(await a.waitFor((m) => m.t === 'peer-leave')).toMatchObject({ peerId: b.peerId });
    const c = await connect(server);
    expect((await join(c, 'shop/presence:app')) as { peers: unknown[] }).toMatchObject({
      peers: [{ peerId: a.peerId }],
    });
    closeAll(a, b, c);
  });

  it('announces a disconnect and deletes empty rooms', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(a, 'shop/presence:app');
    await join(b, 'shop/presence:app');
    expect(server.app.hub.roomCount).toBe(1);
    b.close();
    expect(await a.waitFor((m) => m.t === 'peer-leave')).toMatchObject({ peerId: b.peerId });
    a.close();
    await a.closed;
    await expect.poll(() => server.app.hub.roomCount).toBe(0);
    expect(server.app.hub.connectionCount).toBe(0);
  });

  it('ignores leaving a room you never joined', async () => {
    server = await startTestServer();
    const a = await connect(server);
    a.send({ t: 'leave', room: 'shop/presence:nope' });
    a.send({ t: 'ping', ts: 1 });
    await a.waitFor((m) => m.t === 'pong');
    expect(a.of('error')).toEqual([]);
    a.close();
  });

  it('isolates rooms from each other', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(a, 'shop/presence:one');
    await join(b, 'shop/presence:two');
    a.send({ t: 'ping', ts: 1 });
    await a.waitFor((m) => m.t === 'pong');
    expect(a.of('peer-join')).toEqual([]);
    a.close();
    b.close();
  });

  it('rejoining updates presence without a second peer-join', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(a, 'shop/presence:app');
    await join(b, 'shop/presence:app', { n: 1 }, 'first');
    await join(b, 'shop/presence:app', { n: 2 }, 'second');
    await a.waitFor((m) => m.t === 'presence');
    expect(a.of('peer-join')).toHaveLength(1);
    expect(a.of('presence')[0]).toMatchObject({ peerId: b.peerId, patch: { n: 2 } });
    a.close();
    b.close();
  });
});

describe('join restrictions', () => {
  const failedJoin = async (c: Peer, room: string, id = 'j1') => {
    c.send({ t: 'join', id, room });
    return c.waitFor((m) => m.t === 'error' && m.ref === id);
  };

  it('refuses rooms of another app, with the join id as ref', async () => {
    server = await startTestServer();
    const a = await connect(server, { appId: 'shop' });
    expect(await failedJoin(a, 'blog/presence:app')).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    expect(server.app.hub.roomCount).toBe(0);
    a.close();
  });

  it('caps call rooms at CALL_MAX_PARTICIPANTS', async () => {
    server = await startTestServer({ CALL_MAX_PARTICIPANTS: '2' });
    const [a, b, c] = [await connect(server), await connect(server), await connect(server)];
    await join(a, 'shop/call:x');
    await join(b, 'shop/call:x');
    expect(await failedJoin(c, 'shop/call:x')).toMatchObject({
      error: { code: 'FORBIDDEN', details: { reason: 'room-full' } },
    });
    // Other room kinds are not capped, and a leaver frees a seat.
    await join(c, 'shop/presence:x');
    b.send({ t: 'leave', room: 'shop/call:x' });
    await a.waitFor((m) => m.t === 'peer-leave');
    await join(c, 'shop/call:x', undefined, 'again');
    closeAll(a, b, c);
  });

  it('limits how many rooms one connection may join', async () => {
    server = await startTestServer({}, { hub: { maxRoomsPerConnection: 2 } });
    const a = await connect(server);
    await join(a, 'shop/presence:a');
    await join(a, 'shop/presence:b');
    expect(await failedJoin(a, 'shop/presence:c')).toMatchObject({
      error: { details: { reason: 'too-many-rooms' } },
    });
    a.close();
  });

  it('keeps direct-message rooms private to their members', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    const aUser = (a.frames[0] as { user: { id: string } }).user.id;
    server.app.db.orm
      .insert(conversations)
      .values({ id: 'dm:1', appId: 'shop', kind: 'direct', createdAt: 't', createdBy: aUser })
      .run();
    server.app.db.orm
      .insert(conversationMembers)
      .values({ conversationId: 'dm:1', userId: aUser, joinedAt: 't' })
      .run();
    expect(await join(a, 'shop/chat:dm:1')).toMatchObject({ peers: [] });
    expect(await failedJoin(b, 'shop/chat:dm:1')).toMatchObject({ error: { code: 'FORBIDDEN' } });
    a.close();
    b.close();
  });

  it('applies the collection read rule to docs rooms', async () => {
    server = await startTestServer({ AUTH_MODE: 'secret', JWT_SECRET: 's'.repeat(32) });
    const token = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('s'.repeat(32)));
    const a = await connect(server, { token });
    expect(await join(a, 'shop/docs:cards')).toMatchObject({ peers: [] });
    a.close();
  });

  it('rejects malformed room names at the schema level', async () => {
    server = await startTestServer();
    const a = await connect(server);
    a.send({ t: 'join', id: 'x', room: 'no-slash' });
    expect(await a.waitFor((m) => m.t === 'error')).toMatchObject({
      error: { code: 'VALIDATION' },
    });
    a.close();
  });
});

describe('presence', () => {
  it('shallow-merges patches and tells the others, not the sender', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await join(a, 'shop/presence:app');
    await join(b, 'shop/presence:app', { name: 'b', typing: false });
    b.send({ t: 'presence', room: 'shop/presence:app', patch: { typing: true } });
    expect(await a.waitFor((m) => m.t === 'presence')).toMatchObject({
      peerId: b.peerId,
      patch: { typing: true },
    });
    expect(b.of('presence')).toEqual([]);

    // A later joiner sees the merged state, not just the last patch.
    const c = await connect(server);
    const joined = (await join(c, 'shop/presence:app')) as {
      peers: Array<{ peerId: string; presence: object }>;
    };
    expect(joined.peers.find((p) => p.peerId === b.peerId)?.presence).toEqual({
      name: 'b',
      typing: true,
    });
    closeAll(a, b, c);
  });

  it('requires membership and a small JSON object', async () => {
    server = await startTestServer();
    const a = await connect(server);
    a.send({ t: 'presence', room: 'shop/presence:app', patch: { x: 1 } });
    expect(await a.waitFor((m) => m.t === 'error')).toMatchObject({
      error: { code: 'FORBIDDEN', details: { reason: 'not-in-room' } },
    });
    await join(a, 'shop/presence:app');
    a.send({ t: 'presence', room: 'shop/presence:app', patch: [1, 2] });
    a.send({ t: 'presence', room: 'shop/presence:app', patch: { blob: 'x'.repeat(3000) } });
    await a.waitFor(() => a.of('error').length === 3);
    expect(
      a
        .of('error')
        .slice(1)
        .every((e) => e.error.code === 'VALIDATION'),
    ).toBe(true);
    a.close();
  });
});
