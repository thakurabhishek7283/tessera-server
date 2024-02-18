import { ChatHistoryRes } from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messageReactions } from '../src/db/schema.js';
import { bearer, guest } from './helpers.js';
import {
  connect,
  joinRoom,
  type Peer,
  request,
  startTestServer,
  type TestServer,
  userId,
} from './ws.js';

let server: TestServer;
let a: Peer;
let ids: string[];

const ROOM = 'shop/chat:general';
const history = async (data: Record<string, unknown>, who: Peer = a, room = ROOM) => {
  const res = await request(who, room, 'chat.history', { conversationId: 'general', ...data });
  return res;
};
const page = async (data: Record<string, unknown>) => {
  const res = await history(data);
  expect(res.ok).toBe(true);
  return ChatHistoryRes.parse(res.data);
};

beforeEach(async () => {
  server = await startTestServer({}, { hub: { chatSendBurst: 1000, chatSendPerSecond: 1000 } });
  a = await connect(server);
  await joinRoom(a, ROOM);
  ids = [];
  for (let i = 0; i < 25; i++) {
    const res = await request(a, ROOM, 'chat.send', {
      conversationId: 'general',
      clientId: `c${i}`,
      body: { type: 'text', text: `m${i}` },
    });
    ids.push((res.data as { id: string }).id);
  }
});
afterEach(async () => server.close());

describe('chat.history', () => {
  it('returns the newest page in chronological order by default', async () => {
    const p = await page({ limit: 10 });
    expect(p.messages.map((m) => m.id)).toEqual(ids.slice(15));
    expect(p.hasMore).toBe(true);
  });

  it('uses a default page size of 30', async () => {
    const p = await page({});
    expect(p.messages).toHaveLength(25);
    expect(p.hasMore).toBe(false);
  });

  it('pages back through older messages with before', async () => {
    const newest = await page({ limit: 10 });
    const older = await page({ limit: 10, before: newest.messages[0]?.id });
    expect(older.messages.map((m) => m.id)).toEqual(ids.slice(5, 15));
    expect(older.hasMore).toBe(true);
    const oldest = await page({ limit: 10, before: older.messages[0]?.id });
    expect(oldest.messages.map((m) => m.id)).toEqual(ids.slice(0, 5));
    expect(oldest.hasMore).toBe(false);
  });

  it('gap-fills forwards with after until hasMore is false', async () => {
    const seen: string[] = [];
    let cursor = ids[4];
    for (;;) {
      const p = await page({ limit: 8, after: cursor });
      seen.push(...p.messages.map((m) => m.id));
      cursor = p.messages.at(-1)?.id;
      if (!p.hasMore) break;
    }
    expect(seen).toEqual(ids.slice(5));
    expect((await page({ after: ids.at(-1) })).messages).toEqual([]);
  });

  it('rejects before and after together and oversized limits', async () => {
    expect(await history({ before: ids[3], after: ids[1] })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await history({ limit: 101 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('aggregates reactions and shows deleted messages as tombstones', async () => {
    const target = ids[24] as string;
    server.app.db.orm
      .insert(messageReactions)
      .values([
        { messageId: target, userId: 'u1', emoji: '👍', createdAt: '2023-01-01T00:00:01Z' },
        { messageId: target, userId: 'u2', emoji: '👍', createdAt: '2023-01-01T00:00:02Z' },
        { messageId: target, userId: 'u1', emoji: '🎉', createdAt: '2023-01-01T00:00:03Z' },
      ])
      .run();
    server.app.db.sqlite
      .prepare("UPDATE messages SET deleted_at = '2023-01-02T00:00:00Z' WHERE id = ?")
      .run(ids[23]);

    const p = await page({ limit: 2 });
    const [tomb, reacted] = p.messages;
    expect(reacted?.reactions).toEqual({ '👍': ['u1', 'u2'], '🎉': ['u1'] });
    expect(tomb).toMatchObject({ deletedAt: '2023-01-02T00:00:00Z', attachments: [] });
    expect(JSON.stringify(tomb)).not.toContain('m23');
  });

  it('is empty for a room conversation nobody has posted in, without creating it', async () => {
    const res = await request(a, ROOM, 'chat.history', { conversationId: 'quiet' });
    expect(res).toMatchObject({ ok: true, data: { messages: [], hasMore: false } });
    const row = server.app.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = 'shop/quiet'")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('hides direct conversations from non-members', async () => {
    const b = await connect(server);
    await joinRoom(b, ROOM);
    const dm = await request(a, ROOM, 'chat.open-direct', { userId: userId(b) });
    const dmId = (dm.data as { id: string }).id;
    const c = await connect(server);
    await joinRoom(c, ROOM);
    expect(await request(c, ROOM, 'chat.history', { conversationId: dmId })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await request(b, ROOM, 'chat.history', { conversationId: dmId })).toMatchObject({
      ok: true,
    });
  });
});

describe('GET /v1/chat/:appId/conversations/:id/messages', () => {
  const get = async (path: string, token?: string) =>
    server.app.inject({
      method: 'GET',
      url: `/v1/chat/shop/conversations/${path}`,
      ...(token ? { headers: bearer(token) } : {}),
    });

  it('mirrors chat.history', async () => {
    const res = await get('general/messages?limit=5');
    expect(res.statusCode).toBe(200);
    const body = ChatHistoryRes.parse(res.json());
    expect(body.messages.map((m) => m.id)).toEqual(ids.slice(20));
    expect(body.hasMore).toBe(true);

    const older = await get(`general/messages?limit=5&before=${body.messages[0]?.id}`);
    expect(ChatHistoryRes.parse(older.json()).messages.map((m) => m.id)).toEqual(ids.slice(15, 20));
    const newer = await get(`general/messages?after=${ids[22]}`);
    expect(ChatHistoryRes.parse(newer.json()).messages.map((m) => m.id)).toEqual(ids.slice(23));
  });

  it('validates the query and hides other users’ direct conversations', async () => {
    expect((await get(`general/messages?before=a&after=b`)).statusCode).toBe(400);
    expect((await get('general/messages?limit=0')).statusCode).toBe(400);
    const { token } = await guest(server.app, 'Zed');
    expect((await get('dm:abc/messages', token)).statusCode).toBe(404);
    expect((await get('bad%20id/messages', token)).statusCode).toBe(400);
  });
});
