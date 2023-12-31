import { createRemoteJWKSet } from 'jose';
import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { type TokenVerifier, type VerifierDeps, verifyJwt } from './verifier.js';

/**
 * Verifier for tokens issued by an external identity provider (Auth0, Clerk, Keycloak, …).
 * Keys are fetched from `JWKS_URL` and cached by jose; only asymmetric algorithms are accepted so
 * a token can never be validated against a public key used as an HMAC secret.
 */
export function createJwksVerifier(env: Env, deps: VerifierDeps): TokenVerifier {
  if (!env.jwksUrl) throw new Error('JWKS_URL is required for AUTH_MODE=jwks');
  const keys = createRemoteJWKSet(new URL(env.jwksUrl));

  return {
    async verify(token) {
      if (token === null) throw new AppError('UNAUTHORIZED', 'A token is required');
      return verifyJwt(token, keys, { algorithms: ['RS256', 'ES256'] }, env, deps.clock, {
        requireExp: true,
      });
    },
  };
}
