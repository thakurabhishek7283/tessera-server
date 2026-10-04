import type { AddressInfo } from 'node:net';
import type { ClientMessage, ServerMessage } from '@tessera-kit/protocol';
import { WebSocket } from 'ws';
import type { BuildAppOptions } from '../src/app.js';
import { buildApp } from '../src/app.js';
import { testEnv } from './helpers.js';

export interface TestServer {
  /** `ws://127.0.0.1:<port>/v1/ws` */
  url: string;
  /** `http://127.0.0.1:<port>` */
  httpUrl: string;
  app: Awaited<ReturnType<typeof buildApp>>;
  close(): Promise<void>;
}

/** Boots the real app on an ephemeral port with an in-memory database. */
export async function startTestServer(
  env: Record<string, string> = {},
  extra: Partial<BuildAppOptions> = {},
): Promise<TestServer> {
  const app = await buildApp({ env: testEnv(env), logger: false, ...extra });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/v1/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    app,
    close: () => app.close(),
  };
}

export interface WsClient {
  ws: WebSocket;
  /** Every frame received so far, in order. */
  frames: ServerMessage[];
  /** Resolves with the close code once the socket is closed. */
  closed: Promise<number>;
  send(msg: ClientMessage | Record<string, unknown>): void;
  sendRaw(data: string | Buffer): void;
  /** Waits for the first received frame (past or future) matching `pred`. */
  waitFor<T extends ServerMessage>(
    pred: (m: ServerMessage) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  /** Frames of one type received so far. */
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[];
  close(): void;
}

/** Opens a socket and records everything the server sends. */
export async function wsClient(url: string, opts: { autoPong?: boolean } = {}): Promise<WsClient> {
  const ws = new WebSocket(url, opts);
  const frames: ServerMessage[] = [];
  const waiters: Array<{
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    frames.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const waitFor = (
    pred: (m: ServerMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<ServerMessage> => {
    const hit = frames.find((f) => pred(f));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out; received: ${JSON.stringify(frames)}`)),
        timeoutMs,
      );
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };

  return {
    ws,
    frames,
    closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    sendRaw: (data) => ws.send(data),
    waitFor: waitFor as WsClient['waitFor'],
    of: (t) => frames.filter((f) => f.t === t) as never,
    close: () => ws.close(),
  };
}

/** Connects, says hello and waits for `welcome`. */
export async function connect(
  server: TestServer,
  opts: { appId?: string; token?: string | null } = {},
): Promise<WsClient & { peerId: string }> {
  const client = await wsClient(server.url);
  client.send({ t: 'hello', v: 1, token: opts.token ?? null, appId: opts.appId ?? 'shop' });
  const welcome = await client.waitFor((m) => m.t === 'welcome');
  return Object.assign(client, { peerId: (welcome as { peerId: string }).peerId });
}

/** Closes every client; keeps tests free of `forEach` callbacks that return a value. */
export function closeAll(...clients: WsClient[]): void {
  for (const c of clients) c.close();
}

export type Peer = WsClient & { peerId: string };

/** The user id the server assigned (from the welcome frame). */
export function userId(c: WsClient): string {
  const welcome = c.frames.find((f) => f.t === 'welcome');
  if (welcome?.t !== 'welcome') throw new Error('no welcome frame');
  return welcome.user.id;
}

/** Joins a room and waits for the acknowledgement. */
export async function joinRoom(c: WsClient, room: string): Promise<void> {
  c.send({ t: 'join', id: `join:${room}`, room });
  await c.waitFor((m) => m.t === 'joined' && m.id === `join:${room}`);
}

let requestCounter = 0;

/** Sends a `req` on `room` and resolves with the matching `res` frame. */
export async function request(
  c: WsClient,
  room: string,
  topic: string,
  data: unknown,
): Promise<Extract<ServerMessage, { t: 'res' }>> {
  const id = `req-${++requestCounter}`;
  c.send({ t: 'req', id, room, topic, data });
  return (await c.waitFor((m) => m.t === 'res' && m.id === id)) as Extract<
    ServerMessage,
    { t: 'res' }
  >;
}
