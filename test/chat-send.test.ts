import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversation, Message, UploadRes } from '@tessera-kit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { uploads } from '../src/db/schema.js';
import { bearer, guest, multipartBody, PNG } from './helpers.js';
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
const text = (t: string) => ({ type: 'text', text: t });
const send = (c: Peer, over: Record<string, unknown> = {}, room = ROOM) =>
  request(c, room, 'chat.send', {
    conversationId: 'general',
    clientId: 'c1',
    body: text('hi'),
    ...over,
  });

const twoUsers = async () => {
  server = await startTestServer();
  const a = await connect(server);
  const b = await connect(server);
  await joinRoom(a, ROOM);
  await joinRoom(b, ROOM);
  return { a, b };
};

describe('chat.send', () => {
  it('stores the message, returns it and broadcasts chat.message to the room', async () => {
    const { a, b } = await twoUsers();
    const res = await send(a, { clientId: 'cid-1', body: text('hello') });
    expect(res.ok).toBe(true);
    const message = Message.parse(res.data);
    expect(message).toMatchObject({
      clientId: 'cid-1',
      conversationId: 'general',
      authorId: userId(a),
      body: text('hello'),
      attachments: [],
      reactions: {},
    });
    expect(message.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const pushed = await b.waitFor((m) => m.t === 'msg' && m.topic === 'chat.message');
    expect(pushed).toMatchObject({ from: 'server', room: ROOM, data: { id: message.id } });
    // The sender gets the broadcast too and dedupes on clientId.
    await a.waitFor((m) => m.t === 'msg' && m.topic === 'chat.message');
    closeAll(a, b);
  });

  it('is idempotent per (conversation, author, clientId): retries return the stored message once', async () => {
    const { a, b } = await twoUsers();
    const first = await send(a, { clientId: 'retry' });
    const again = await send(a, { clientId: 'retry', body: text('different text') });
    expect((again.data as { id: string }).id).toBe((first.data as { id: string }).id);
    expect((again.data as { body: unknown }).body).toEqual(text('hi'));
    const rows = server.app.db.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    await b.waitFor((m) => m.t === 'msg');
    b.send({ t: 'ping', ts: 1 });
    await b.waitFor((m) => m.t === 'pong');
    expect(b.of('msg')).toHaveLength(1);
    closeAll(a, b);
  });

  it('does not treat another user’s identical clientId as a duplicate', async () => {
    const { a, b } = await twoUsers();
    const m1 = await send(a, { clientId: 'same' });
    const m2 = await send(b, { clientId: 'same' });
    expect((m1.data as { id: string }).id).not.toBe((m2.data as { id: string }).id);
    closeAll(a, b);
  });

  it('keeps message ids sortable in send order', async () => {
    const { a, b } = await twoUsers();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(((await send(a, { clientId: `m${i}` })).data as { id: string }).id);
    expect([...ids].sort()).toEqual(ids);
    closeAll(a, b);
  });

  it('keeps the same conversation id separate per app', async () => {
    server = await startTestServer();
    const shop = await connect(server, { appId: 'shop' });
    const blog = await connect(server, { appId: 'blog' });
    await joinRoom(shop, 'shop/chat:general');
    await joinRoom(blog, 'blog/chat:general');
    await send(shop, { clientId: 'x' });
    await send(blog, { clientId: 'x', body: text('other app') }, 'blog/chat:general');
    const count = server.app.db.sqlite.prepare('SELECT COUNT(*) AS n FROM conversations').get() as {
      n: number;
    };
    expect(count.n).toBe(2);
    blog.send({ t: 'ping', ts: 1 });
    await blog.waitFor((m) => m.t === 'pong');
    expect(blog.of('msg').map((m) => (m.data as { body: unknown }).body)).toEqual([
      text('other app'),
    ]);
    closeAll(shop, blog);
  });

  it('validates the body and the conversation id', async () => {
    const { a } = await twoUsers();
    const long = await send(a, { clientId: 'l', body: text('x'.repeat(4001)) });
    expect(long).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const empty = await send(a, { clientId: 'e', body: text('') });
    expect(empty).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const hugeDoc = {
      type: 'rich',
      doc: { type: 'doc', content: [{ type: 'paragraph', text: 'y'.repeat(33 * 1024) }] },
    };
    expect(await send(a, { clientId: 'r', body: hugeDoc })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    const smallDoc = { type: 'rich', doc: { type: 'doc', content: [{ type: 'paragraph' }] } };
    expect((await send(a, { clientId: 'ok', body: smallDoc })).ok).toBe(true);
    expect(
      await send(a, { clientId: 'bad-id', conversationId: 'no spaces/allowed' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    a.close();
  });

  it('supports replies within a conversation only', async () => {
    const { a } = await twoUsers();
    const parent = (await send(a, { clientId: 'p' })).data as { id: string };
    const ok = await send(a, { clientId: 'r1', replyTo: parent.id });
    expect(ok.data).toMatchObject({ replyTo: parent.id });
    expect(await send(a, { clientId: 'r2', replyTo: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });

    await joinRoom(a, 'shop/chat:other');
    const other = await request(a, 'shop/chat:other', 'chat.send', {
      conversationId: 'other',
      clientId: 'r3',
      body: text('x'),
      replyTo: parent.id,
    });
    expect(other).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    a.close();
  });

  it('rate limits sends per user', async () => {
    server = await startTestServer({}, { hub: { chatSendBurst: 3, chatSendPerSecond: 1 } });
    const a = await connect(server);
    await joinRoom(a, ROOM);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await send(a, { clientId: `m${i}` }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    expect(results[3]).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    a.close();
  });

  it('refuses writes the authorizer denies', async () => {
    server = await startTestServer({}, {});
    const original = server.app.authorizer;
    (server.app.authorizer as { canWrite: unknown }).canWrite = () => false;
    const a = await connect(server);
    await joinRoom(a, ROOM);
    expect(await send(a)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    (server.app.authorizer as { canWrite: unknown }).canWrite = original.canWrite;
    a.close();
  });
});

describe('chat.send with a real upload', () => {
  it('attaches a file stored through POST /v1/uploads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-chat-'));
    try {
      server = await startTestServer({ UPLOAD_DIR: dir });
      const { token } = await guest(server.app, 'Ada');
      const { payload, headers } = multipartBody({
        data: PNG,
        filename: 'cat.png',
        type: 'image/png',
      });
      const up = await server.app.inject({
        method: 'POST',
        url: '/v1/uploads/shop',
        payload,
        headers: { ...bearer(token), ...headers },
      });
      const upload = UploadRes.parse(up.json());

      const a = await connect(server, { token });
      await joinRoom(a, ROOM);
      const res = await send(a, {
        attachments: [{ id: upload.id, url: '', name: 'cat.png', mime: 'image/png', size: 1 }],
      });
      expect(Message.parse(res.data).attachments).toEqual([{ ...upload, name: 'cat.png' }]);
      a.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('chat.send attachments', () => {
  const seedUpload = (ownerId: string, id = 'up1') =>
    server.app.db.orm
      .insert(uploads)
      .values({
        id,
        appId: 'shop',
        ownerId,
        mime: 'image/png',
        size: 123,
        width: 10,
        height: 20,
        path: `${id}.png`,
        createdAt: 't',
      })
      .run();

  it('attaches the caller’s own uploads using the stored metadata', async () => {
    const { a } = await twoUsers();
    seedUpload(userId(a));
    const res = await send(a, {
      attachments: [
        { id: 'up1', url: 'https://evil.test/x', name: 'pic.png', mime: 'text/html', size: 1 },
      ],
    });
    expect(Message.parse(res.data).attachments).toEqual([
      {
        id: 'up1',
        url: 'http://localhost:8787/uploads/up1.png',
        name: 'pic.png',
        mime: 'image/png',
        size: 123,
        width: 10,
        height: 20,
      },
    ]);
    a.close();
  });

  it('rejects unknown uploads and other users’ uploads', async () => {
    const { a, b } = await twoUsers();
    seedUpload(userId(b));
    const att = { id: 'up1', url: 'u', name: 'n', mime: 'image/png', size: 1 };
    expect(await send(a, { attachments: [att] })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await send(a, { attachments: [{ ...att, id: 'nope' }] })).toMatchObject({ ok: false });
    closeAll(a, b);
  });
});

describe('chat.open-direct', () => {
  it('derives the same private conversation for both users and keeps others out', async () => {
    server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    const c = await connect(server);
    await joinRoom(a, ROOM);
    await joinRoom(b, ROOM);
    await joinRoom(c, ROOM);

    const fromA = await request(a, ROOM, 'chat.open-direct', { userId: userId(b) });
    const fromB = await request(b, ROOM, 'chat.open-direct', { userId: userId(a) });
    const dm = Conversation.parse(fromA.data);
    expect(dm).toMatchObject({ kind: 'direct', unread: 0, members: [userId(a), userId(b)].sort() });
    expect(dm.id).toMatch(/^dm:[0-9a-f]{24}$/);
    expect(Conversation.parse(fromB.data).id).toBe(dm.id);

    const dmRoom = `shop/chat:${dm.id}`;
    await joinRoom(a, dmRoom);
    await joinRoom(b, dmRoom);
    c.send({ t: 'join', id: 'denied', room: dmRoom });
    expect(await c.waitFor((m) => m.t === 'error' && m.ref === 'denied')).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });

    const sent = await request(a, dmRoom, 'chat.send', {
      conversationId: dm.id,
      clientId: 'd1',
      body: text('psst'),
    });
    expect(sent.ok).toBe(true);
    await b.waitFor((m) => m.t === 'msg' && m.room === dmRoom);
    const outsider = await request(c, ROOM, 'chat.send', {
      conversationId: dm.id,
      clientId: 'd2',
      body: text('let me in'),
    });
    expect(outsider).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    closeAll(a, b, c);
  });

  it('refuses to open a conversation with yourself', async () => {
    server = await startTestServer();
    const a = await connect(server);
    await joinRoom(a, ROOM);
    expect(await request(a, ROOM, 'chat.open-direct', { userId: userId(a) })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    a.close();
  });

  it('never creates a direct conversation implicitly through chat.send', async () => {
    server = await startTestServer();
    const a = await connect(server);
    await joinRoom(a, ROOM);
    const res = await send(a, { conversationId: 'dm:made-up' });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    a.close();
  });
});
