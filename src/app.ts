import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { guestRoutes } from './auth/guest.js';
import { createVerifier, type TokenVerifier } from './auth/index.js';
import { type Authorizer, createAuthorizer } from './auth/policy.js';
import { type Db, openDatabase } from './db/client.js';
import type { Env } from './env.js';
import type { Broker } from './hub/broker.js';
import type { HubOptions } from './hub/options.js';
import { registerHub } from './hub/plugin.js';
import { AppError, ConflictError, toWireError } from './lib/errors.js';
import { AppEvents } from './lib/events.js';
import { type Clock, createIds, type Ids, systemClock } from './lib/ids.js';
import { parseQuery } from './lib/query.js';
import { registerChatHandlers } from './modules/chat/handlers.js';
import { docsRoutes } from './modules/docs/routes.js';
import { healthRoutes } from './modules/health/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    ids: Ids;
    clock: Clock;
    db: Db;
    verifier: TokenVerifier;
    authorizer: Authorizer;
    events: AppEvents;
  }
}

/** Dependencies and overrides for {@link buildApp}; tests pass fakes here. */
export interface BuildAppOptions {
  env: Env;
  ids?: Ids;
  clock?: Clock;
  /** Use an already-open database instead of opening `env.databasePath`. */
  db?: Db;
  /** Replaces the verifier chosen by `AUTH_MODE`; see `TokenVerifier`. */
  verifier?: TokenVerifier;
  /** Replaces the default access rules; see `Authorizer`. */
  authorizer?: Authorizer;
  /** Overrides hub timings and limits (tests use short timeouts). */
  hub?: Partial<HubOptions>;
  /** Room fan-out transport; defaults to in-process. See `Broker` for multi-instance setups. */
  broker?: Broker;
  /** Overrides the pino logger configuration derived from `env.logLevel`. */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Creates the Fastify app without listening, so tests can use `inject()` and real sockets alike.
 *
 * @example
 * const app = await buildApp({ env: parseEnv() });
 * await app.listen({ port: app.env.port, host: app.env.host });
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = opts;
  const app = Fastify({
    logger: opts.logger ?? {
      level: env.logLevel,
      // Tokens travel in headers and in the WS hello frame; never write them to logs.
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
    },
    bodyLimit: 1024 * 1024,
    // Behind a reverse proxy the real client address is needed for rate limiting.
    trustProxy: true,
    routerOptions: { querystringParser: (search) => parseQuery(search) as Record<string, string> },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('env', env);
  app.decorate('ids', opts.ids ?? createIds());
  app.decorate('clock', opts.clock ?? systemClock);
  app.decorate('events', new AppEvents());

  const db = opts.db ?? openDatabase(env.databasePath);
  app.decorate('db', db);
  // Only close what this app opened; a caller-supplied database stays the caller's.
  if (!opts.db) app.addHook('onClose', () => db.close());

  app.decorate(
    'verifier',
    opts.verifier ?? createVerifier(env, { clock: app.clock, ids: app.ids }),
  );
  app.decorate('authorizer', opts.authorizer ?? createAuthorizer(env, db));

  await app.register(helmet);
  await app.register(cors, {
    origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'if-match'],
    exposedHeaders: ['etag'],
  });

  // Per client IP; `/health` opts out so probes never get throttled.
  await app.register(rateLimit, { max: env.rateLimitPerMinute, timeWindow: '1 minute' });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send({ error: toWireError('NOT_FOUND', `Route ${req.method} ${req.url} not found`) });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ConflictError) {
      return reply.code(409).send({ error: err.toWire(), current: err.current });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.toWire() });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: toWireError('VALIDATION', 'Request validation failed', {
          issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message ?? '' })),
        }),
      });
    }
    // Fastify's own errors (bad JSON, payload too large, rate limit, …) carry a 4xx statusCode.
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    const status = typeof statusCode === 'number' ? statusCode : 500;
    if (status === 429) {
      return reply.code(429).send({ error: toWireError('RATE_LIMITED', 'Too many requests') });
    }
    if (status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: toWireError('VALIDATION', message ?? 'Bad request') });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: toWireError('UNKNOWN', 'Internal server error') });
  });

  const hub = await registerHub(app, opts.hub, opts.broker);
  registerChatHandlers(hub, env);
  await app.register(healthRoutes);
  await app.register(docsRoutes);
  if (env.authMode === 'dev') await app.register(guestRoutes);

  return app;
}
