import { ChatReactionEvent, Message } from '@tessera-kit/protocol';
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
  userId,
} from './ws.js';

let server: TestServer;
afterEach(async () => server.close());

const ROOM = 'shop/chat:general';
const SECRET = 's'.repeat(32);
const text = (t: string) => ({ type: 'text', text: t });

const token = (sub: string, roles?: string[]) =>
  new SignJWT({ sub, name: sub, ...(roles ? { roles } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));

const setup = async () => {
  server = await startTestServer({ AUTH_MODE: 'secret', JWT_SECRET: SECRET });
  const alice = await connect(server, { token: await token('alice') });
  const bob = await connect(server, { token: await token('bob') });
  const mod = await connect(server, { token: await token('mod', ['moderator']) });
  for (const c of [alice, bob, mod]) await joinRoom(c, ROOM);
  return { alice, bob, mod };
};

const post = async (c: Peer, body = text('original'), clientId = `c-${Math.random()}`) => {
  const res = await request(c, ROOM, 'chat.send', { conversationId: 'general', clientId, body });
  return (res.data as { id: string }).id;
};

const pushes = (c: Peer, topic: string) =>
  c.frames.filter((f) => f.t === 'msg' && f.topic === topic);

describe('chat.edit', () => {
  it('lets the author change the body and tells the room', async () => {
    const { alice, bob } = await setup();
    const id = await post(alice);
    const res = await request(alice, ROOM, 'chat.edit', { messageId: id, body: text('edited') });
    const message = Message.parse(res.data);
    expect(message).toMatchObject({ id, body: text('edited'), editedAt: expect.any(String) });

    const pushed = await bob.waitFor((m) => m.t === 'msg' && m.topic === 'chat.message-updated');
    expect(pushed).toMatchObject({ from: 'server', data: { id, body: text('edited') } });
    closeAll(alice, bob);
  });

  it('refuses other users, missing messages, deleted messages and bad bodies', async () => {
    const { alice, bob, mod } = await setup();
    const id = await post(alice);
    expect(await request(bob, ROOM, 'chat.edit', { messageId: id, body: text('x') })).toMatchObject(
      {
        ok: false,
        error: { code: 'FORBIDDEN' },
      },
    );
    // Moderators may delete but not rewrite someone else's words.
    expect(await request(mod, ROOM, 'chat.edit', { messageId: id, body: text('x') })).toMatchObject(
      {
        ok: false,
        error: { code: 'FORBIDDEN' },
      },
    );
    expect(
      await request(alice, ROOM, 'chat.edit', { messageId: 'nope', body: text('x') }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      await request(alice, ROOM, 'chat.edit', { messageId: id, body: text('') }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    await request(alice, ROOM, 'chat.delete', { messageId: id });
    expect(
      await request(alice, ROOM, 'chat.edit', { messageId: id, body: text('x') }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    closeAll(alice, bob, mod);
  });

  it('cannot reach messages of another app', async () => {
    const { alice } = await setup();
    const id = await post(alice);
    const other = await connect(server, { appId: 'blog', token: await token('alice') });
    await joinRoom(other, 'blog/chat:general');
    expect(
      await request(other, 'blog/chat:general', 'chat.edit', { messageId: id, body: text('x') }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    closeAll(alice, other);
  });
});

describe('chat.delete', () => {
  it('lets the author delete, clears the content and announces a tombstone', async () => {
    const { alice, bob } = await setup();
    const id = await post(alice, text('embarrassing'));
    const res = await request(alice, ROOM, 'chat.delete', { messageId: id });
    expect(Message.parse(res.data)).toMatchObject({
      id,
      deletedAt: expect.any(String),
      attachments: [],
    });

    const pushed = await bob.waitFor((m) => m.t === 'msg' && m.topic === 'chat.message-updated');
    expect(JSON.stringify(pushed)).not.toContain('embarrassing');
    const stored = server.app.db.sqlite
      .prepare('SELECT body, attachments FROM messages WHERE id = ?')
      .get(id);
    expect(JSON.stringify(stored)).not.toContain('embarrassing');
    closeAll(alice, bob);
  });

  it('lets a moderator delete anyone’s message but not a regular user', async () => {
    const { alice, bob, mod } = await setup();
    const id = await post(alice);
    expect(await request(bob, ROOM, 'chat.delete', { messageId: id })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await request(mod, ROOM, 'chat.delete', { messageId: id })).toMatchObject({ ok: true });
    closeAll(alice, bob, mod);
  });

  it('is idempotent and announces only the first deletion', async () => {
    const { alice, bob } = await setup();
    const id = await post(alice);
    const first = await request(alice, ROOM, 'chat.delete', { messageId: id });
    const again = await request(alice, ROOM, 'chat.delete', { messageId: id });
    expect(again.data).toEqual(first.data);
    bob.send({ t: 'ping', ts: 1 });
    await bob.waitFor((m) => m.t === 'pong');
    expect(pushes(bob, 'chat.message-updated')).toHaveLength(1);
    closeAll(alice, bob);
  });

  it('answers NOT_FOUND for unknown ids', async () => {
    const { alice } = await setup();
    expect(await request(alice, ROOM, 'chat.delete', { messageId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    alice.close();
  });
});

describe('chat.react', () => {
  it('toggles reactions, aggregates per emoji and broadcasts changes', async () => {
    const { alice, bob } = await setup();
    const id = await post(alice);

    const on = await request(bob, ROOM, 'chat.react', { messageId: id, emoji: '👍', on: true });
    expect(on).toMatchObject({ ok: true, data: { messageId: id, reactions: { '👍': ['bob'] } } });
    const event = await alice.waitFor((m) => m.t === 'msg' && m.topic === 'chat.reaction');
    expect(ChatReactionEvent.parse((event as { data: unknown }).data)).toEqual({
      conversationId: 'general',
      messageId: id,
      emoji: '👍',
      userId: 'bob',
      on: true,
    });

    const both = await request(alice, ROOM, 'chat.react', { messageId: id, emoji: '👍', on: true });
    expect((both.data as { reactions: object }).reactions).toEqual({ '👍': ['bob', 'alice'] });

    const off = await request(bob, ROOM, 'chat.react', { messageId: id, emoji: '👍', on: false });
    expect((off.data as { reactions: object }).reactions).toEqual({ '👍': ['alice'] });
    const gone = await request(alice, ROOM, 'chat.react', {
      messageId: id,
      emoji: '👍',
      on: false,
    });
    expect((gone.data as { reactions: object }).reactions).toEqual({});
    closeAll(alice, bob);
  });

  it('does not broadcast no-op changes', async () => {
    const { alice, bob } = await setup();
    const id = await post(alice);
    await request(alice, ROOM, 'chat.react', { messageId: id, emoji: '🎉', on: true });
    await request(alice, ROOM, 'chat.react', { messageId: id, emoji: '🎉', on: true });
    await request(alice, ROOM, 'chat.react', { messageId: id, emoji: '❤️', on: false });
    bob.send({ t: 'ping', ts: 1 });
    await bob.waitFor((m) => m.t === 'pong');
    expect(pushes(bob, 'chat.reaction')).toHaveLength(1);
    closeAll(alice, bob);
  });

  it('shows reactions in later history', async () => {
    const { alice, bob } = await setup();
    const id = await post(alice);
    await request(bob, ROOM, 'chat.react', { messageId: id, emoji: '👍', on: true });
    const hist = await request(alice, ROOM, 'chat.history', { conversationId: 'general' });
    expect(
      (hist.data as { messages: Array<{ reactions: object }> }).messages[0]?.reactions,
    ).toEqual({ '👍': ['bob'] });
    closeAll(alice, bob);
  });

  it('rejects blank emoji, deleted messages and too many distinct reactions', async () => {
    const { alice } = await setup();
    const id = await post(alice);
    expect(
      await request(alice, ROOM, 'chat.react', { messageId: id, emoji: '  ', on: true }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(
      await request(alice, ROOM, 'chat.react', { messageId: id, emoji: 'x'.repeat(17), on: true }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    for (let i = 0; i < 20; i++) {
      await request(alice, ROOM, 'chat.react', { messageId: id, emoji: `e${i}`, on: true });
    }
    expect(
      await request(alice, ROOM, 'chat.react', { messageId: id, emoji: 'e20', on: true }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    // Existing emoji can still gain users.
    expect(
      await request(alice, ROOM, 'chat.react', { messageId: id, emoji: 'e3', on: false }),
    ).toMatchObject({ ok: true });
    await request(alice, ROOM, 'chat.delete', { messageId: id });
    expect(
      await request(alice, ROOM, 'chat.react', { messageId: id, emoji: 'e1', on: true }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    alice.close();
  });

  it('keeps direct-message messages private', async () => {
    const { alice, bob, mod } = await setup();
    const dm = await request(alice, ROOM, 'chat.open-direct', { userId: 'bob' });
    const dmId = (dm.data as { id: string }).id;
    const dmRoom = `shop/chat:${dmId}`;
    await joinRoom(alice, dmRoom);
    const sent = await request(alice, dmRoom, 'chat.send', {
      conversationId: dmId,
      clientId: 'x',
      body: text('secret'),
    });
    const id = (sent.data as { id: string }).id;
    for (const topic of ['chat.react', 'chat.delete', 'chat.edit']) {
      const data =
        topic === 'chat.react'
          ? { messageId: id, emoji: '👍', on: true }
          : topic === 'chat.edit'
            ? { messageId: id, body: text('x') }
            : { messageId: id };
      expect(await request(mod, ROOM, topic, data)).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND' },
      });
    }
    expect(
      await request(bob, ROOM, 'chat.react', { messageId: id, emoji: '👍', on: true }),
    ).toMatchObject({ ok: true });
    expect(userId(alice)).toBe('alice');
    closeAll(alice, bob, mod);
  });
});
