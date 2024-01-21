import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import type { Authorizer, TokenVerifier } from '../auth/index.js';
import type { Clock, Ids } from '../lib/ids.js';
import { Connection } from './connection.js';
import type { HubOptions } from './options.js';

export interface HubDeps {
  verifier: TokenVerifier;
  authorizer: Authorizer;
  ids: Ids;
  clock: Clock;
}

/** Owns every live connection (and, soon, the rooms they join). */
export class Hub {
  private readonly connections = new Set<Connection>();

  constructor(
    readonly deps: HubDeps,
    readonly options: HubOptions,
  ) {}

  /** Adopts a freshly upgraded socket. */
  accept(socket: WebSocket, log: FastifyBaseLogger): Connection {
    const conn = new Connection(socket, this, log);
    this.connections.add(conn);
    return conn;
  }

  unregister(conn: Connection): void {
    this.connections.delete(conn);
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}
