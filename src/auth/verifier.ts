import { UserInfoSchema } from '@tessera-kit/protocol';
import { type JWTPayload, type JWTVerifyGetKey, type JWTVerifyOptions, jwtVerify } from 'jose';
import type { z } from 'zod';
import type { ClaimNames, Env } from '../env.js';
import { AppError } from '../lib/errors.js';
import type { Clock, Ids } from '../lib/ids.js';

type WireUser = z.infer<typeof UserInfoSchema>;

/** The authenticated caller, as the hub, routes and the authorizer see them. */
export interface AuthUser extends WireUser {
  /** True only for dev-mode connections that sent no token. */
  anonymous: boolean;
  /** App ids the token may access; `null` means the token is not restricted to specific apps. */
  apps: string[] | null;
}

/** Fields of {@link AuthUser} that are sent to clients (`welcome`, `peer-join`, …). */
export function publicUser(user: AuthUser): WireUser {
  const { anonymous: _a, apps: _p, ...wire } = user;
  return wire;
}

/**
 * Turns a bearer token into a user. This is the "bring your own auth" seam: implement it to
 * accept tokens from any identity provider. Throw `AppError('UNAUTHORIZED')` to reject.
 */
export interface TokenVerifier {
  verify(token: string | null): Promise<AuthUser>;
}

export interface VerifierDeps {
  clock: Clock;
  ids: Ids;
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function asStringList(v: unknown): string[] | undefined {
  if (typeof v === 'string' && v) return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return undefined;
}

/** Maps verified JWT claims to a user using the configurable `JWT_CLAIM_*` names. */
export function userFromClaims(payload: JWTPayload, names: ClaimNames): AuthUser {
  const id = asString(payload[names.userId]);
  if (!id) throw new AppError('UNAUTHORIZED', `Token has no "${names.userId}" claim`);

  const avatar = asString(payload[names.avatar]);
  const roles = asStringList(payload[names.roles]);
  const candidate = {
    id,
    name: asString(payload[names.name]) ?? id,
    ...(avatar === undefined ? {} : { avatarUrl: avatar }),
    ...(roles === undefined ? {} : { roles }),
  };
  const parsed = UserInfoSchema.safeParse(candidate);
  if (!parsed.success) throw new AppError('UNAUTHORIZED', 'Token claims are not acceptable');

  return { ...parsed.data, anonymous: false, apps: asStringList(payload[names.apps]) ?? null };
}

/** Verifies `token` with `key`, translating every jose failure into `UNAUTHORIZED`. */
export async function verifyJwt(
  token: string,
  key: Uint8Array | JWTVerifyGetKey,
  options: JWTVerifyOptions,
  env: Env,
  clock: Clock,
  { requireExp }: { requireExp: boolean },
): Promise<AuthUser> {
  try {
    const verifyOptions: JWTVerifyOptions = { ...options, currentDate: clock.now() };
    if (env.jwtIssuer) verifyOptions.issuer = env.jwtIssuer;
    if (env.jwtAudience) verifyOptions.audience = env.jwtAudience;
    if (requireExp) verifyOptions.requiredClaims = ['exp'];
    // `key` is either raw bytes (HS256) or a key resolver (JWKS); jose has overloads for each.
    const { payload } =
      key instanceof Uint8Array
        ? await jwtVerify(token, key, verifyOptions)
        : await jwtVerify(token, key, verifyOptions);
    return userFromClaims(payload, env.claims);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('UNAUTHORIZED', 'Invalid or expired token');
  }
}

/** HS256 verifier for `dev` (guests allowed) and `secret` (host app signs with a shared secret). */
export function createSecretVerifier(env: Env, deps: VerifierDeps): TokenVerifier {
  const key = new TextEncoder().encode(env.jwtSecret);
  const dev = env.authMode === 'dev';

  return {
    async verify(token) {
      if (token === null) {
        if (!dev) throw new AppError('UNAUTHORIZED', 'A token is required');
        const suffix = deps.ids.guest();
        return {
          id: `guest-${suffix}`,
          name: `Guest ${suffix.slice(0, 4)}`,
          anonymous: true,
          apps: null,
        };
      }
      // Dev guest tokens always carry `exp`, but a hand-made dev token need not.
      return verifyJwt(token, key, { algorithms: ['HS256'] }, env, deps.clock, {
        requireExp: !dev,
      });
    },
  };
}
