import {
  type ClientMessage,
  CloseCode,
  decodeClientFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
  type ServerMessage,
  type WireError,
} from '@tessera/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { type AuthUser, publicUser } from '../auth/index.js';
import { AppError, toWireError } from '../lib/errors.js';
import type { Hub, Presence } from './hub.js';

type State = 'await-hello' | 'ready' | 'closed';

const APP_ID = /^[a-z0-9-]{1,40}$/;
const OPEN = 1;

/**
 * One websocket client. Frames are handled strictly in arrival order so a `join` sent right after
 * `hello` never overtakes token verification.
 */
export class Connection {
  state: State = 'await-hello';
  peerId = '';
  appId = '';
  user: AuthUser | undefined;
  readonly rooms = new Set<string>();

  private queue: Promise<void> = Promise.resolve();
  private helloTimer: NodeJS.Timeout | undefined;
  private invalidFrames: number[] = [];
  private cleanedUp = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly hub: Hub,
    private readonly log: FastifyBaseLogger,
  ) {
    const { helloTimeoutMs } = hub.options;
    this.helloTimer = setTimeout(
      () => this.close(CloseCode.HelloTimeout, 'hello timeout'),
      helloTimeoutMs,
    );

    socket.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    socket.on('close', () => this.onClosed());
    socket.on('error', (err) => this.log.debug({ err }, 'socket error'));
  }

  /** Sends a frame unless the socket is already going away. */
  send(msg: ServerMessage): void {
    if (this.socket.readyState === OPEN) this.socket.send(encodeFrame(msg));
  }

  sendError(error: WireError, ref?: string): void {
    this.send(ref === undefined ? { t: 'error', error } : { t: 'error', error, ref });
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') return;
    this.socket.close(code, reason);
    // Stop processing immediately instead of waiting for the close handshake to finish.
    this.onClosed();
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.state === 'closed') return;
    if (isBinary) {
      this.sendError(toWireError('VALIDATION', 'Binary frames are not supported'));
      this.noteInvalidFrame();
      return;
    }
    const raw = rawToString(data);
    if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
      this.close(CloseCode.FrameTooLarge, 'frame too large');
      return;
    }
    this.queue = this.queue
      .then(() => this.handleRaw(raw))
      .catch((err: unknown) =>
        this.log.error({ err, peerId: this.peerId }, 'frame handler failed'),
      );
  }

  private async handleRaw(raw: string): Promise<void> {
    if (this.state === 'closed') return;
    const decoded = decodeClientFrame(raw);
    if (!decoded.ok) {
      this.sendError(toWireError('VALIDATION', 'Invalid frame', { reason: decoded.reason }));
      this.noteInvalidFrame();
      return;
    }
    const msg = decoded.msg;

    if (this.state === 'await-hello') {
      if (msg.t !== 'hello') {
        this.sendError(toWireError('VALIDATION', 'Expected hello as the first frame'));
        this.close(CloseCode.ProtocolViolation, 'expected hello');
        return;
      }
      await this.onHello(msg);
      return;
    }
    await this.dispatch(msg);
  }

  private async onHello(msg: Extract<ClientMessage, { t: 'hello' }>): Promise<void> {
    if (!APP_ID.test(msg.appId)) {
      this.sendError(toWireError('VALIDATION', 'appId must match [a-z0-9-]{1,40}'));
      this.close(CloseCode.ProtocolViolation, 'bad appId');
      return;
    }
    let user: AuthUser;
    try {
      user = await this.hub.deps.verifier.verify(msg.token);
      if (!this.hub.deps.authorizer.canAccessApp(user, msg.appId)) {
        throw new AppError('FORBIDDEN', `Token may not access app "${msg.appId}"`);
      }
    } catch (err) {
      const error =
        err instanceof AppError ? err : new AppError('UNAUTHORIZED', 'Authentication failed');
      this.sendError(error.toWire());
      this.close(CloseCode.Unauthorized, error.code === 'FORBIDDEN' ? 'forbidden' : 'unauthorized');
      return;
    }
    // The socket may have closed while the token was being verified.
    if (this.state !== 'await-hello') return;

    clearTimeout(this.helloTimer);
    this.user = user;
    this.appId = msg.appId;
    this.peerId = this.hub.deps.ids.peer();
    this.state = 'ready';
    this.send({
      t: 'welcome',
      v: 1,
      peerId: this.peerId,
      user: publicUser(user),
      serverTime: this.hub.deps.clock.now().getTime(),
    });
  }

  private async dispatch(msg: ClientMessage): Promise<void> {
    switch (msg.t) {
      case 'hello':
        this.sendError(toWireError('VALIDATION', 'Already authenticated'));
        return;
      case 'ping':
        this.send({
          t: 'pong',
          ts: msg.ts,
          serverTime: this.hub.deps.clock.now().getTime(),
        });
        return;
      case 'join':
        this.onJoin(msg);
        return;
      case 'leave':
        this.hub.leave(this, msg.room);
        return;
      case 'presence':
        this.guard(undefined, () => this.hub.updatePresence(this, msg.room, msg.patch));
        return;
      case 'pub':
        this.guard(undefined, () => this.hub.publish(this, msg.room, msg.topic, msg.data));
        return;
      case 'direct':
        this.guard(undefined, () => this.hub.direct(this, msg.room, msg.to, msg.topic, msg.data));
        return;
      default:
        this.sendError(toWireError('NOT_FOUND', `Frame "${msg.t}" is not supported yet`));
    }
  }

  private onJoin(msg: Extract<ClientMessage, { t: 'join' }>): void {
    this.guard(msg.id, () => {
      const peers = this.hub.join(this, msg.room, (msg.presence ?? {}) as Presence);
      this.send({ t: 'joined', id: msg.id, room: msg.room, peers });
    });
  }

  /** Runs a handler, turning thrown {@link AppError}s into `error` frames tied to `ref`. */
  private guard(ref: string | undefined, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      this.sendError(err.toWire(), ref);
    }
  }

  /** Tolerates a few bad frames (clients have bugs) but not a stream of them. */
  private noteInvalidFrame(): void {
    const now = this.hub.deps.clock.now().getTime();
    this.invalidFrames = this.invalidFrames.filter((t) => now - t < 60_000);
    this.invalidFrames.push(now);
    if (this.invalidFrames.length >= this.hub.options.maxInvalidFramesPerMinute) {
      this.close(CloseCode.ProtocolViolation, 'too many invalid frames');
    }
  }

  private onClosed(): void {
    // `close()` cleans up eagerly and the socket's own close event follows; do it once.
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    clearTimeout(this.helloTimer);
    this.state = 'closed';
    this.hub.unregister(this);
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
