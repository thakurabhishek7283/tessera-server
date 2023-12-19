import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { type Db, openDatabase } from './db/client.js';
import type { Env } from './env.js';
import { AppError, toWireError } from './lib/errors.js';
import { type Clock, createIds, type Ids, systemClock } from './lib/ids.js';
import { healthRoutes } from './modules/health/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    ids: Ids;
    clock: Clock;
    db: Db;
  }
}

/** Dependencies and overrides for {@link buildApp}; tests pass fakes here. */
export interface BuildAppOptions {
  env: Env;
  ids?: Ids;
  clock?: Clock;
  /** Use an already-open database instead of opening `env.databasePath`. */
  db?: Db;
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
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('env', env);
  app.decorate('ids', opts.ids ?? createIds());
  app.decorate('clock', opts.clock ?? systemClock);

  const db = opts.db ?? openDatabase(env.databasePath);
  app.decorate('db', db);
  // Only close what this app opened; a caller-supplied database stays the caller's.
  if (!opts.db) app.addHook('onClose', () => db.close());

  await app.register(helmet);
  await app.register(cors, {
    origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'if-match'],
    exposedHeaders: ['etag'],
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send({ error: toWireError('NOT_FOUND', `Route ${req.method} ${req.url} not found`) });
  });

  app.setErrorHandler((err, req, reply) => {
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

  await app.register(healthRoutes);

  return app;
}
