// Runs the real @tessera client packages (transport, storage) against this server, so wire
// compatibility is checked from the client's side rather than only with hand-written frames.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthProvider,
  createIdGenerator,
  createLogger,
  type DocChange,
  systemClock,
  type Transport,
} from '@tessera-kit/core';
import type { MessageDto } from '@tessera-kit/protocol';
import { createRestStorage, createRestUploads } from '@tessera-kit/storage';
import { createWebSocketTransport } from '@tessera-kit/transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, guest, PNG } from './helpers.js';
import { startTestServer, type TestServer } from './ws.js';

interface Client {
  transport: Transport;
  auth: AuthProvider;
  userId: string;
}

let server: TestServer;
let uploadDir: string;
const transports: Transport[] = [];

beforeEach(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), 'tessera-interop-'));
  server = await startTestServer(
    { UPLOAD_DIR: uploadDir },
    { hub: { chatSendBurst: 100, chatSendPerSecond: 100 } },
  );
});
afterEach(async () => {
  for (const t of transports.splice(0)) t.disconnect();
  await server.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

async function client(name: string): Promise<Client> {
  const { token, id } = await guest(server.app, name);
  const auth: AuthProvider = {
    getUser: () => null,
    getToken: async () => token,
    onChange: () => () => {},
  };
  const transport = createWebSocketTransport({
    url: server.url,
    appId: 'demo',
    auth,
    ids: createIdGenerator(),
    clock: systemClock,
    logger: createLogger('silent'),
    reconnect: { initialDelayMs: 20, maxDelayMs: 100, jitter: 0 },
  });
  transports.push(transport);
  await transport.connect();
  return { transport, auth, userId: id };
}

const storageFor = (c: Client) =>
  createRestStorage({
    baseUrl: server.httpUrl,
    appId: 'demo',
    auth: c.auth,
    transport: () => c.transport,
  });

describe('WebSocketTransport ↔ tessera-server', () => {
  it('connects and advertises server capabilities', async () => {
    const a = await client('Ada');
    expect(a.transport.state.get()).toBe('open');
    expect(a.transport.capabilities.serverHistory).toBe(true);
  });

  it('shows peers, presence, broadcasts and direct messages across clients', async () => {
    const a = await client('Ada');
    const b = await client('Bo');
    const roomA = await a.transport.join('call:x', { presence: { audio: true } });
    const roomB = await b.transport.join('call:x', { presence: { audio: false } });

    await expect.poll(() => roomA.peers.get().map((p) => p.user.name)).toEqual(['Bo']);
    expect(roomB.peers.get()).toMatchObject([{ user: { name: 'Ada' }, presence: { audio: true } }]);

    roomB.setPresence({ audio: true, hand: true });
    await expect.poll(() => roomA.peers.get()[0]?.presence).toEqual({ audio: true, hand: true });

    const broadcasts: unknown[] = [];
    roomA.on('hello.world', (data, from) =>
      broadcasts.push([data, from === 'server' ? from : from.user.name]),
    );
    roomB.publish('hello.world', { n: 1 });
    await expect.poll(() => broadcasts).toEqual([[{ n: 1 }, 'Bo']]);

    const signals: unknown[] = [];
    roomB.on('rtc.signal', (data) => signals.push(data));
    const bPeerId = roomA.peers.get()[0]?.peerId as string;
    roomA.send(bPeerId, 'rtc.signal', { description: { type: 'offer', sdp: 'v=0' } });
    await expect.poll(() => signals).toEqual([{ description: { type: 'offer', sdp: 'v=0' } }]);

    await roomB.leave();
    await expect.poll(() => roomA.peers.get()).toEqual([]);
  });

  it('rejects joining a call room once it is full', async () => {
    const limited = await startTestServer({ CALL_MAX_PARTICIPANTS: '2' });
    const make = async () => {
      const { token } = await guest(limited.app);
      const t = createWebSocketTransport({
        url: limited.url,
        appId: 'demo',
        auth: { getUser: () => null, getToken: async () => token, onChange: () => () => {} },
        ids: createIdGenerator(),
        clock: systemClock,
        logger: createLogger('silent'),
      });
      transports.push(t);
      await t.connect();
      return t;
    };
    const [t1, t2, t3] = [await make(), await make(), await make()];
    await t1.join('call:full');
    await t2.join('call:full');
    await expect(t3.join('call:full')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await limited.close();
  });

  it('supports the chat request/broadcast flow end to end', async () => {
    const a = await client('Ada');
    const b = await client('Bo');
    const roomA = await a.transport.join('chat:general');
    const roomB = await b.transport.join('chat:general');

    const received: MessageDto[] = [];
    roomB.on<MessageDto>('chat.message', (m) => received.push(m));

    const sent = await roomA.request<MessageDto>('chat.send', {
      conversationId: 'general',
      clientId: 'c1',
      body: { type: 'text', text: 'hello Bo' },
    });
    expect(sent).toMatchObject({ authorName: 'Ada', body: { text: 'hello Bo' } });
    await expect.poll(() => received.map((m) => m.id)).toEqual([sent.id]);

    const history = await roomB.request<{ messages: MessageDto[]; hasMore: boolean }>(
      'chat.history',
      {
        conversationId: 'general',
      },
    );
    expect(history.messages.map((m) => m.id)).toEqual([sent.id]);

    const reaction = await roomB.request<{ reactions: Record<string, string[]> }>('chat.react', {
      messageId: sent.id,
      emoji: '👍',
      on: true,
    });
    expect(reaction.reactions).toEqual({ '👍': [b.userId] });

    await expect(
      roomA.request('chat.edit', { messageId: sent.id, body: { type: 'text', text: 'x' } }),
    ).resolves.toBeDefined();
    await expect(
      roomB.request('chat.edit', { messageId: sent.id, body: { type: 'text', text: 'y' } }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(roomA.request('does.not-exist', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejoins its rooms and signals $reconnected after the server drops it', async () => {
    const a = await client('Ada');
    const b = await client('Bo');
    const roomA = await a.transport.join('presence:app', { presence: { here: true } });
    const roomB = await b.transport.join('presence:app');

    let reconnected = 0;
    roomA.on('$reconnected', () => reconnected++);
    server.app.hub.closeAll(1012, 'service restart');

    await expect.poll(() => reconnected, { timeout: 5000 }).toBe(1);
    expect(a.transport.state.get()).toBe('open');
    await expect
      .poll(
        () =>
          roomB.peers
            .get()
            .map((p) => p.user.name)
            .sort(),
        { timeout: 5000 },
      )
      .toEqual(['Ada']);
    expect(roomB.peers.get()[0]?.presence).toEqual({ here: true });
  });
});

describe('RestStorage ↔ tessera-server', () => {
  it('creates, reads, lists with filters and pages, and deletes documents', async () => {
    const store = storageFor(await client('Ada'));
    const card = await store.put('kanban.cards', {
      id: 'c1',
      data: { title: 'one', col: 'todo', rank: 2 },
    });
    expect(card).toMatchObject({ id: 'c1', version: 1, data: { title: 'one' } });
    await store.put('kanban.cards', { id: 'c2', data: { title: 'two', col: 'todo', rank: 1 } });
    await store.put('kanban.cards', { id: 'c3', data: { title: 'three', col: 'done', rank: 3 } });

    expect(await store.get('kanban.cards', 'c1')).toMatchObject({ data: { title: 'one' } });
    expect(await store.get('kanban.cards', 'missing')).toBeNull();

    const todo = await store.list<{ title: string }>('kanban.cards', {
      where: { col: 'todo' },
      orderBy: { field: 'rank' },
    });
    expect(todo.items.map((d) => d.data.title)).toEqual(['two', 'one']);

    const byRank = await store.list<{ title: string }>('kanban.cards', { where: { rank: 3 } });
    expect(byRank.items.map((d) => d.id)).toEqual(['c3']);

    const first = await store.list('kanban.cards', { limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await store.list('kanban.cards', {
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items.map((d) => d.id)).toEqual(['c3']);

    await store.delete('kanban.cards', 'c1');
    expect(await store.get('kanban.cards', 'c1')).toBeNull();
    await expect(store.delete('kanban.cards', 'c1')).resolves.toBeUndefined();
  });

  it('turns a stale version into a CONFLICT carrying the server copy', async () => {
    const store = storageFor(await client('Ada'));
    await store.put('kanban.cards', { id: 'c1', data: { n: 1 } });
    await store.put('kanban.cards', { id: 'c1', data: { n: 2 }, version: 1 });
    const err = await store
      .put('kanban.cards', { id: 'c1', data: { n: 3 }, version: 1 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'CONFLICT',
      details: { current: { version: 2, data: { n: 2 } } },
    });
  });

  it('streams changes made by other clients through watch()', async () => {
    const watcher = await client('Ada');
    const writer = await client('Bo');
    const changes: DocChange[] = [];
    const stop = storageFor(watcher).watch?.('kanban.cards', (c) => changes.push(c));
    // Joining the docs room is asynchronous; give the join a moment before writing.
    await expect
      .poll(() => server.app.hub.peersOf('demo/docs:kanban.cards').length, { timeout: 3000 })
      .toBe(1);

    const writes = storageFor(writer);
    await writes.put('kanban.cards', { id: 'c1', data: {} });
    await writes.put('kanban.cards', { id: 'c1', data: { n: 1 }, version: 1 });
    await writes.delete('kanban.cards', 'c1');
    await expect
      .poll(() => changes.map((c) => [c.id, c.version, c.deleted ?? false]))
      .toEqual([
        ['c1', 1, false],
        ['c1', 2, false],
        ['c1', 3, true],
      ]);
    expect(changes[0]?.by).toBe(writer.userId);
    stop?.();
  });

  it('does not leak changes from other collections', async () => {
    const watcher = await client('Ada');
    const store = storageFor(watcher);
    const changes: DocChange[] = [];
    store.watch?.('a.items', (c) => changes.push(c));
    await expect.poll(() => server.app.hub.peersOf('demo/docs:a.items').length).toBe(1);
    await store.put('b.items', { id: 'x', data: {} });
    await store.put('a.items', { id: 'y', data: {} });
    await expect.poll(() => changes.map((c) => c.id)).toEqual(['y']);
  });
});

describe('RestUploads ↔ tessera-server', () => {
  it('uploads through the client adapter and serves the file back', async () => {
    const a = await client('Ada');
    const uploads = createRestUploads({ baseUrl: server.httpUrl, appId: 'demo', auth: a.auth });
    const result = await uploads.upload(new Blob([PNG], { type: 'image/png' }), {
      name: 'dot.png',
    });
    expect(result).toMatchObject({ mime: 'image/png', size: PNG.length, width: 3, height: 2 });

    // PUBLIC_URL is a deployment setting; the test server listens on an ephemeral port instead.
    const res = await fetch(new URL(new URL(result.url).pathname, server.httpUrl));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('surfaces server-side rejections as TesseraErrors', async () => {
    const a = await client('Ada');
    const uploads = createRestUploads({
      baseUrl: server.httpUrl,
      appId: 'demo',
      auth: a.auth,
      accept: ['image/*', 'text/plain'],
    });
    await expect(
      uploads.upload(new Blob(['<script>'], { type: 'image/png' })),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});

describe('REST helpers used by clients', () => {
  it('lets a client mint a dev guest token and call authenticated endpoints with it', async () => {
    const { token } = await guest(server.app, 'Zed');
    const res = await fetch(`${server.httpUrl}/v1/ice`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('iceServers');
  });
});
