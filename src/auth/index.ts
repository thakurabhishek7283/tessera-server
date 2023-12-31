import type { Env } from '../env.js';
import { createJwksVerifier } from './jwks.js';
import { createSecretVerifier, type TokenVerifier, type VerifierDeps } from './verifier.js';

export type { AuthUser, TokenVerifier } from './verifier.js';
export { publicUser } from './verifier.js';

/** Picks the verifier for `AUTH_MODE`. */
export function createVerifier(env: Env, deps: VerifierDeps): TokenVerifier {
  return env.authMode === 'jwks' ? createJwksVerifier(env, deps) : createSecretVerifier(env, deps);
}
