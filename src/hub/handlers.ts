import { type RequestTopic, type TopicResponse, TopicSchemas } from '@tessera-kit/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Authorizer, AuthUser } from '../auth/index.js';
import type { Db } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import type { Clock, Ids } from '../lib/ids.js';
import type { Hub } from './hub.js';

/** What a request handler may use; built per request from the caller's connection. */
export interface HandlerContext {
  user: AuthUser;
  peerId: string;
  /** The room the request was sent on (the caller is a member). */
  room: string;
  appId: string;
  hub: Hub;
  db: Db;
  ids: Ids;
  clock: Clock;
  authorizer: Authorizer;
  log: FastifyBaseLogger;
}

type Definition = {
  // Any zod 4 schema: protocol schemas are zod/mini, host-specific ones may be classic.
  schema: z.core.$ZodType;
  fn: (ctx: HandlerContext, req: never) => unknown;
};

/**
 * `req` topic → handler. Requests are validated with the zod schema from `@tessera-kit/protocol`
 * before the handler runs, so handlers only ever see well-formed input.
 */
export class HandlerRegistry {
  private readonly definitions = new Map<string, Definition>();

  /** Registers a handler for a topic defined in `@tessera-kit/protocol`. */
  register<T extends RequestTopic>(
    topic: T,
    fn: (
      ctx: HandlerContext,
      req: z.output<(typeof TopicSchemas)[T]['request']>,
    ) => Promise<TopicResponse<T>> | TopicResponse<T>,
  ): void {
    this.define(
      topic,
      TopicSchemas[topic].request as z.core.$ZodType,
      fn as (ctx: HandlerContext, req: unknown) => unknown,
    );
  }

  /** Registers a handler with its own request schema (host-specific topics). */
  define<S extends z.core.$ZodType>(
    topic: string,
    schema: S,
    fn: (ctx: HandlerContext, req: z.output<S>) => unknown,
  ): void {
    if (this.definitions.has(topic))
      throw new Error(`Handler for "${topic}" is already registered`);
    this.definitions.set(topic, { schema, fn: fn as Definition['fn'] });
  }

  has(topic: string): boolean {
    return this.definitions.has(topic);
  }

  get topics(): string[] {
    return [...this.definitions.keys()];
  }

  /** Validates `data` and runs the handler; throws {@link AppError} for client mistakes. */
  async handle(topic: string, ctx: HandlerContext, data: unknown): Promise<unknown> {
    const def = this.definitions.get(topic);
    if (!def) throw new AppError('NOT_FOUND', `Unknown request topic "${topic}"`);
    const parsed = z.safeParse(def.schema, data);
    if (!parsed.success) {
      throw new AppError('VALIDATION', 'Invalid request', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return def.fn(ctx, parsed.data as never);
  }
}
