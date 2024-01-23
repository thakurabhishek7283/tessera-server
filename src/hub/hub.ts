import {
  type JsonValue,
  MAX_PRESENCE_BYTES,
  type ServerMessage,
  type WirePeer,
} from '@tessera/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { type Authorizer, publicUser, type TokenVerifier } from '../auth/index.js';
import { parseRoom } from '../auth/policy.js';
import { AppError } from '../lib/errors.js';
import type { Unsubscribe } from '../lib/events.js';
import type { Clock, Ids } from '../lib/ids.js';
import { jsonBytes } from '../lib/json.js';
import { type Broker, InMemoryBroker } from './broker.js';
import { Connection } from './connection.js';
import type { HubOptions } from './options.js';

export interface HubDeps {
  verifier: TokenVerifier;
  authorizer: Authorizer;
  ids: Ids;
  clock: Clock;
  broker?: Broker;
  callMaxParticipants: number;
}

export type Presence = Record<string, JsonValue>;

interface HubPeer {
  conn: Connection;
  presence: Presence;
}

interface HubRoom {
  name: string;
  appId: string;
  peers: Map<string, HubPeer>;
  /** Detaches this instance from the broker once its last local peer has left. */
  unsubscribe: Unsubscribe;
}

/** Owns every live connection and the rooms they join. */
export class Hub {
  readonly broker: Broker;
  private readonly connections = new Set<Connection>();
  private readonly rooms = new Map<string, HubRoom>();

  constructor(
    readonly deps: HubDeps,
    readonly options: HubOptions,
  ) {
    this.broker = deps.broker ?? new InMemoryBroker();
  }

  /** Adopts a freshly upgraded socket. */
  accept(socket: WebSocket, log: FastifyBaseLogger): Connection {
    const conn = new Connection(socket, this, log);
    this.connections.add(conn);
    return conn;
  }

  /** Drops a closed connection and announces its departure in every room it was in. */
  unregister(conn: Connection): void {
    this.connections.delete(conn);
    for (const name of [...conn.rooms]) this.leave(conn, name);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /** Peers currently in a room on this instance (for handlers and tests). */
  peersOf(room: string): WirePeer[] {
    return [...(this.rooms.get(room)?.peers.values() ?? [])].map(toWirePeer);
  }

  /**
   * Adds the connection to a room and returns the peers that were already there.
   * Joining a room you are in replaces your presence (what a client does after reconnecting).
   */
  join(conn: Connection, name: string, presence: Presence): WirePeer[] {
    const parsed = parseRoom(name);
    if (!parsed || parsed.appId !== conn.appId || !conn.user) {
      throw new AppError('FORBIDDEN', 'Room belongs to a different app');
    }
    if (!this.deps.authorizer.canJoin(conn.user, name)) {
      throw new AppError('FORBIDDEN', 'Not allowed to join this room', { reason: 'denied' });
    }
    assertPresence(presence);

    const existing = this.rooms.get(name);
    const already = existing?.peers.get(conn.peerId);
    if (!already) {
      if (conn.rooms.size >= this.options.maxRoomsPerConnection) {
        throw new AppError('FORBIDDEN', 'Too many rooms', { reason: 'too-many-rooms' });
      }
      if (parsed.kind === 'call' && (existing?.peers.size ?? 0) >= this.deps.callMaxParticipants) {
        throw new AppError('FORBIDDEN', 'Room is full', { reason: 'room-full' });
      }
    }

    const room = existing ?? this.openRoom(name, parsed.appId);
    const others = [...room.peers.values()].filter((p) => p.conn !== conn).map(toWirePeer);
    room.peers.set(conn.peerId, { conn, presence });
    conn.rooms.add(name);

    if (already) {
      this.broker.publish(
        name,
        { t: 'presence', room: name, peerId: conn.peerId, patch: presence },
        conn.peerId,
      );
    } else {
      const peer = toWirePeer({ conn, presence });
      this.broker.publish(name, { t: 'peer-join', room: name, peer }, conn.peerId);
    }
    return others;
  }

  leave(conn: Connection, name: string): void {
    const room = this.rooms.get(name);
    conn.rooms.delete(name);
    if (!room?.peers.delete(conn.peerId)) return;
    this.broker.publish(name, { t: 'peer-leave', room: name, peerId: conn.peerId }, conn.peerId);
    if (room.peers.size === 0) {
      room.unsubscribe();
      this.rooms.delete(name);
    }
  }

  /** Shallow-merges a patch into the peer's presence and tells the rest of the room. */
  updatePresence(conn: Connection, name: string, patch: unknown): void {
    const peer = this.rooms.get(name)?.peers.get(conn.peerId);
    if (!peer) throw new AppError('FORBIDDEN', 'Join the room first', { reason: 'not-in-room' });
    assertPresence(patch);
    peer.presence = { ...peer.presence, ...patch };
    this.broker.publish(
      name,
      { t: 'presence', room: name, peerId: conn.peerId, patch },
      conn.peerId,
    );
  }

  private openRoom(name: string, appId: string): HubRoom {
    const room: HubRoom = {
      name,
      appId,
      peers: new Map(),
      unsubscribe: this.broker.subscribe(name, (frame, exceptPeerId) =>
        this.deliver(name, frame, exceptPeerId),
      ),
    };
    this.rooms.set(name, room);
    return room;
  }

  /** Fans a frame out to this instance's peers in the room. */
  private deliver(name: string, frame: ServerMessage, exceptPeerId?: string): void {
    for (const [peerId, peer] of this.rooms.get(name)?.peers ?? []) {
      if (peerId !== exceptPeerId) peer.conn.send(frame);
    }
  }
}

function toWirePeer(peer: HubPeer): WirePeer {
  // `user` is always set once a connection is in a room.
  return {
    peerId: peer.conn.peerId,
    user: publicUser(peer.conn.user as NonNullable<Connection['user']>),
    presence: peer.presence,
  };
}

/** Presence is a small JSON object; anything else is a client bug or an abuse attempt. */
function assertPresence(value: unknown): asserts value is Presence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('VALIDATION', 'Presence must be a JSON object');
  }
  if (jsonBytes(value) > MAX_PRESENCE_BYTES) {
    throw new AppError('VALIDATION', `Presence is larger than ${MAX_PRESENCE_BYTES} bytes`);
  }
}
