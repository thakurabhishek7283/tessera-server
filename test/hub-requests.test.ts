import { ChatHistoryRes } from '@tessera/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/lib/errors.js';
import { connect, startTestServer, type TestServer, type WsClient } from './ws.js';

let server: TestServer;
afterEach(async () => server.close());

type Peer = WsClient & { peerId: string };
const ROOM = 'shop/chat:general';

const setup = async () => {
  server = await startTestServer();
  const a = await connect(server);
  a.send({ t: 'join', id: 'j', room: ROOM });
  await a.waitFor((m) => m.t === 'joined');
  return a;
};

const req = async (c: Peer, id: string, topic: string, data: unknown = {}, room = ROOM) => {
  c.send({ t: 'req', id, room, topic, data });
  return c.waitFor((m) => m.t === 'res' && m.id === id);
};

describe('req handler registry', () => {
  it('runs a registered handler and returns its result', async () => {
    const a = await setup();
    server.app.hub.handlers.define('test.echo', z.object({ text: z.string() }), (ctx, body) => ({
      echo: body.text,
      user: ctx.user.id,
      room: ctx.room,
      appId: ctx.appId,
      peerId: ctx.peerId,
    }));
    const res = await req(a, 'r1', 'test.echo', { text: 'hi' });
    expect(res).toMatchObject({
      ok: true,
      data: {
        echo: 'hi',
        room: ROOM,
        appId: 'shop',
        peerId: a.peerId,
        user: expect.stringMatching(/^guest-/),
      },
    });
    a.close();
  });

  it('supports async handlers and null results', async () => {
    const a = await setup();
    server.app.hub.handlers.define('test.later', z.object({}), async () => {
      await new Promise((r) => setTimeout(r, 10));
      return undefined;
    });
    expect(await req(a, 'r1', 'test.later')).toMatchObject({ ok: true, data: null });
    a.close();
  });

  it('answers NOT_FOUND for an unknown topic', async () => {
    const a = await setup();
    expect(await req(a, 'r1', 'nothing.here')).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    a.close();
  });

  it('validates input with the protocol schema before the handler runs', async () => {
    const a = await setup();
    let called = false;
    server.app.hub.handlers.register('chat.history', () => {
      called = true;
      return { messages: [], hasMore: false };
    });
    const bad = await req(a, 'r1', 'chat.history', { conversationId: 'general', limit: 5000 });
    expect(bad).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(called).toBe(false);

    const good = await req(a, 'r2', 'chat.history', { conversationId: 'general' });
    expect(good).toMatchObject({ ok: true });
    expect(ChatHistoryRes.parse((good as { data: unknown }).data)).toEqual({
      messages: [],
      hasMore: false,
    });
    a.close();
  });

  it('passes defaults from the schema to the handler', async () => {
    const a = await setup();
    let seen: unknown;
    server.app.hub.handlers.register('chat.history', (_ctx, body) => {
      seen = body;
      return { messages: [], hasMore: false };
    });
    await req(a, 'r1', 'chat.history', { conversationId: 'general' });
    expect(seen).toEqual({ conversationId: 'general', limit: 30 });
    a.close();
  });

  it('turns AppError into a typed failure and hides unexpected errors', async () => {
    const a = await setup();
    server.app.hub.handlers.define('test.deny', z.object({}), () => {
      throw new AppError('FORBIDDEN', 'nope', { why: 'because' });
    });
    server.app.hub.handlers.define('test.boom', z.object({}), () => {
      throw new Error('secret internal detail');
    });
    expect(await req(a, 'r1', 'test.deny')).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'nope', details: { why: 'because' } },
    });
    const boom = await req(a, 'r2', 'test.boom');
    expect(boom).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN', message: 'Internal server error' },
    });
    expect(JSON.stringify(boom)).not.toContain('secret');
    a.close();
  });

  it('requires membership of the room the request is sent on', async () => {
    const a = await setup();
    server.app.hub.handlers.define('test.echo', z.object({}), () => ({}));
    expect(await req(a, 'r1', 'test.echo', {}, 'shop/chat:other')).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', details: { reason: 'not-in-room' } },
    });
    a.close();
  });

  it('does not let a slow handler block the connection', async () => {
    const a = await setup();
    let release: () => void = () => {};
    server.app.hub.handlers.define(
      'test.slow',
      z.object({}),
      () => new Promise((resolve) => (release = () => resolve({ done: true }))),
    );
    a.send({ t: 'req', id: 'slow', room: ROOM, topic: 'test.slow', data: {} });
    a.send({ t: 'ping', ts: 1 });
    await a.waitFor((m) => m.t === 'pong');
    expect(a.of('res')).toEqual([]);
    release();
    expect(await a.waitFor((m) => m.t === 'res' && m.id === 'slow')).toMatchObject({ ok: true });
    a.close();
  });

  it('correlates concurrent requests by id', async () => {
    const a = await setup();
    server.app.hub.handlers.define(
      'test.delay',
      z.object({ ms: z.number(), tag: z.string() }),
      async (_c, b) => {
        await new Promise((r) => setTimeout(r, b.ms));
        return { tag: b.tag };
      },
    );
    const [slow, fast] = await Promise.all([
      req(a, 'slow', 'test.delay', { ms: 60, tag: 'slow' }),
      req(a, 'fast', 'test.delay', { ms: 1, tag: 'fast' }),
    ]);
    expect(slow).toMatchObject({ data: { tag: 'slow' } });
    expect(fast).toMatchObject({ data: { tag: 'fast' } });
    expect(a.of('res').map((r) => r.id)).toEqual(['fast', 'slow']);
    a.close();
  });

  it('refuses to register a topic twice', async () => {
    await setup();
    server.app.hub.handlers.define('test.once', z.object({}), () => ({}));
    expect(() => server.app.hub.handlers.define('test.once', z.object({}), () => ({}))).toThrow(
      /already/,
    );
  });
});
