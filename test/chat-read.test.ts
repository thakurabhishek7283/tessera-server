import { ChatConversationsRes } from '@tessera-kit/protocol';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeAll,
  connect,
  joinRoom,
  type Peer,
  request,
  startTestServer,
  type TestServer,
} from './ws.js';

let server: TestServer;
afterEach(async () => server.close());

const ROOM = 'shop/chat:general';
const SECRET = 's'.repeat(32);
const text = (t: string) => ({ type: 'text', text: t });

const token = (sub: string) =>
  new SignJWT({ sub, name: sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));

const setup = async () => {
  server = await startTestServer(
    { AUTH_MODE: 'secret', JWT_SECRET: SECRET },
    { hub: { chatSendBurst: 1000, chatSendPerSecond: 1000 } },
  );
  const alice = await connect(server, { token: await token('alice') });
  const bob = await connect(server, { token: await token('bob') });
  const carol = await connect(server, { token: await token('carol') });
  for (const c of [alice, bob, carol]) await joinRoom(c, ROOM);
  return { alice, bob, carol };
};

let n = 0;
const post = async (c: Peer, conversationId = 'general', room = ROOM) => {
  const res = await request(c, room, 'chat.send', {
    conversationId,
    clientId: `c${++n}`,
    body: text(`m${n}`),
  });
  return (res.data as { id: string }).id;
};

const conversations = async (c: Peer) => {
  const res = await request(c, ROOM, 'chat.conversations', {});
  expect(res.ok).toBe(true);
  return ChatConversationsRes.parse(res.data).conversations;
};

describe('chat.conversations', () => {
  it('lists room and own direct conversations, newest activity first', async () => {
    const { alice, bob, carol } = await setup();
    await post(alice, 'general');
    await post(alice, 'random');
    const dm = await request(alice, ROOM, 'chat.open-direct', { userId: 'bob' });
    const dmId = (dm.data as { id: string }).id;
    await joinRoom(alice, `shop/chat:${dmId}`);
    await post(alice, dmId, `shop/chat:${dmId}`);

    const forBob = await conversations(bob);
    expect(forBob.map((c) => c.id)).toEqual([dmId, 'random', 'general']);
    expect(forBob[0]).toMatchObject({ kind: 'direct', members: ['alice', 'bob'] });
    expect(forBob[1]).toMatchObject({ kind: 'room', lastMessage: { body: text('m2') } });

    // Carol sees the rooms but not Alice and Bob's private conversation.
    expect((await conversations(carol)).map((c) => c.id)).toEqual(['random', 'general']);
    closeAll(alice, bob, carol);
  });

  it('counts unread messages from others, ignoring own and deleted ones', async () => {
    const { alice, bob } = await setup();
    await post(alice);
    await post(alice);
    const doomed = await post(alice);
    await post(bob);
    await request(alice, ROOM, 'chat.delete', { messageId: doomed });

    expect((await conversations(bob))[0]?.unread).toBe(2);
    expect((await conversations(alice))[0]?.unread).toBe(1);
    closeAll(alice, bob);
  });

  it('is empty for an app with no conversations', async () => {
    const { alice } = await setup();
    expect(await conversations(alice)).toEqual([]);
    alice.close();
  });

  it('keeps apps apart', async () => {
    const { alice } = await setup();
    await post(alice);
    const other = await connect(server, { appId: 'blog', token: await token('alice') });
    await joinRoom(other, 'blog/chat:general');
    const res = await request(other, 'blog/chat:general', 'chat.conversations', {});
    expect(res.data).toEqual({ conversations: [] });
    closeAll(alice, other);
  });
});

describe('chat.read', () => {
  it('moves the marker, lowers unread and broadcasts a read receipt', async () => {
    const { alice, bob } = await setup();
    const m1 = await post(alice);
    const m2 = await post(alice);
    const m3 = await post(alice);

    const res = await request(bob, ROOM, 'chat.read', { conversationId: 'general', messageId: m2 });
    expect(res).toMatchObject({ ok: true, data: { conversationId: 'general', messageId: m2 } });
    expect((await conversations(bob))[0]?.unread).toBe(1);

    const receipt = await alice.waitFor((m) => m.t === 'msg' && m.topic === 'chat.read');
    expect(receipt).toMatchObject({
      room: ROOM,
      from: 'server',
      data: { conversationId: 'general', messageId: m2, userId: 'bob' },
    });

    await request(bob, ROOM, 'chat.read', { conversationId: 'general', messageId: m3 });
    expect((await conversations(bob))[0]?.unread).toBe(0);
    expect(m1 < m2 && m2 < m3).toBe(true);
    closeAll(alice, bob);
  });

  it('never moves the marker backwards and does not re-announce', async () => {
    const { alice, bob } = await setup();
    const m1 = await post(alice);
    const m2 = await post(alice);
    await request(bob, ROOM, 'chat.read', { conversationId: 'general', messageId: m2 });
    const stale = await request(bob, ROOM, 'chat.read', {
      conversationId: 'general',
      messageId: m1,
    });
    expect(stale.data).toMatchObject({ messageId: m2 });
    expect((await conversations(bob))[0]?.unread).toBe(0);

    alice.send({ t: 'ping', ts: 1 });
    await alice.waitFor((m) => m.t === 'pong');
    expect(alice.frames.filter((f) => f.t === 'msg' && f.topic === 'chat.read')).toHaveLength(1);
    closeAll(alice, bob);
  });

  it('tracks markers per user', async () => {
    const { alice, bob, carol } = await setup();
    await post(alice);
    const last = await post(alice);
    await request(bob, ROOM, 'chat.read', { conversationId: 'general', messageId: last });
    expect((await conversations(bob))[0]?.unread).toBe(0);
    expect((await conversations(carol))[0]?.unread).toBe(2);
    closeAll(alice, bob, carol);
  });

  it('rejects unknown messages and messages from another conversation', async () => {
    const { alice, bob } = await setup();
    const inGeneral = await post(alice, 'general');
    await post(alice, 'random');
    expect(
      await request(bob, ROOM, 'chat.read', { conversationId: 'general', messageId: 'nope' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      await request(bob, ROOM, 'chat.read', { conversationId: 'random', messageId: inGeneral }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    closeAll(alice, bob);
  });

  it('does not let outsiders touch direct conversations', async () => {
    const { alice, bob, carol } = await setup();
    const dm = await request(alice, ROOM, 'chat.open-direct', { userId: 'bob' });
    const dmId = (dm.data as { id: string }).id;
    await joinRoom(alice, `shop/chat:${dmId}`);
    const id = await post(alice, dmId, `shop/chat:${dmId}`);
    expect(
      await request(carol, ROOM, 'chat.read', { conversationId: dmId, messageId: id }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      await request(bob, ROOM, 'chat.read', { conversationId: dmId, messageId: id }),
    ).toMatchObject({ ok: true });
    closeAll(alice, bob, carol);
  });
});
