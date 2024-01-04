import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import type { AuthUser } from './verifier.js';

/** Extracts the bearer token from an `Authorization` header, or null when absent. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) throw new AppError('UNAUTHORIZED', 'Malformed Authorization header');
  return match[1];
}

/** Authenticates a REST request; in dev mode a request without a token is an anonymous guest. */
export function authenticate(app: FastifyInstance, req: FastifyRequest): Promise<AuthUser> {
  return app.verifier.verify(bearerToken(req.headers.authorization));
}
