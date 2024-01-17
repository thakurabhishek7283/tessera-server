import { z } from 'zod';

/** Splits a comma-separated list, trimming blanks. */
const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const Schema = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(8787),
    HOST: z.string().default('0.0.0.0'),
    PUBLIC_URL: z.url().default('http://localhost:8787'),
    DATABASE_PATH: z.string().min(1).default('./data/tessera.db'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    AUTH_MODE: z.enum(['dev', 'secret', 'jwks']).default('dev'),
    JWT_SECRET: z.string().default('change-me'),
    JWKS_URL: z.url().optional(),
    JWT_ISSUER: z.string().optional(),
    JWT_AUDIENCE: z.string().optional(),
    JWT_CLAIM_USER_ID: z.string().default('sub'),
    JWT_CLAIM_NAME: z.string().default('name'),
    JWT_CLAIM_AVATAR: z.string().default('picture'),
    JWT_CLAIM_ROLES: z.string().default('roles'),
    JWT_CLAIM_APPS: z.string().default('tessera_apps'),
    UPLOAD_DIR: z.string().default('./data/uploads'),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    UPLOAD_ALLOWED: z.string().default('image/png,image/jpeg,image/webp,image/gif,application/pdf'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
    CALL_MAX_PARTICIPANTS: z.coerce.number().int().min(2).max(32).default(6),
    STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
    TURN_URLS: z.string().optional(),
    TURN_SECRET: z.string().optional(),
    TURN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.AUTH_MODE === 'secret' && env.JWT_SECRET.length < 32) {
      issue('JWT_SECRET', 'must be at least 32 characters when AUTH_MODE=secret');
    }
    if (env.AUTH_MODE === 'jwks' && !env.JWKS_URL) {
      issue('JWKS_URL', 'is required when AUTH_MODE=jwks');
    }
    if (env.AUTH_MODE !== 'dev' && list(env.CORS_ORIGINS).includes('*')) {
      issue('CORS_ORIGINS', "'*' is only allowed when AUTH_MODE=dev");
    }
    if (list(env.TURN_URLS).length > 0 && !env.TURN_SECRET) {
      issue('TURN_SECRET', 'is required when TURN_URLS is set');
    }
  });

/** Names of the JWT claims the verifier reads user fields from. */
export interface ClaimNames {
  userId: string;
  name: string;
  avatar: string;
  roles: string;
  /** Claim holding the app ids a token may access; absent claim means any app. */
  apps: string;
}

/** Validated, typed server configuration. */
export interface Env {
  port: number;
  host: string;
  publicUrl: string;
  databasePath: string;
  corsOrigins: string[];
  authMode: 'dev' | 'secret' | 'jwks';
  jwtSecret: string;
  jwksUrl: string | undefined;
  jwtIssuer: string | undefined;
  jwtAudience: string | undefined;
  claims: ClaimNames;
  uploadDir: string;
  uploadMaxBytes: number;
  uploadAllowed: string[];
  rateLimitPerMinute: number;
  callMaxParticipants: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string | undefined;
  turnTtlSeconds: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

/** Raised when the environment is invalid; the message lists every problem. */
export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/**
 * Validates environment variables once at boot so misconfiguration fails fast with a readable
 * message instead of surfacing later as a runtime error.
 *
 * @example
 * const env = parseEnv(process.env);
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  // `.env.example` ships blank values (`JWKS_URL=`); treat them as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = Schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    databasePath: e.DATABASE_PATH,
    corsOrigins: list(e.CORS_ORIGINS),
    authMode: e.AUTH_MODE,
    jwtSecret: e.JWT_SECRET,
    jwksUrl: e.JWKS_URL,
    jwtIssuer: e.JWT_ISSUER,
    jwtAudience: e.JWT_AUDIENCE,
    claims: {
      userId: e.JWT_CLAIM_USER_ID,
      name: e.JWT_CLAIM_NAME,
      avatar: e.JWT_CLAIM_AVATAR,
      roles: e.JWT_CLAIM_ROLES,
      apps: e.JWT_CLAIM_APPS,
    },
    uploadDir: e.UPLOAD_DIR,
    uploadMaxBytes: e.UPLOAD_MAX_BYTES,
    uploadAllowed: list(e.UPLOAD_ALLOWED),
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    callMaxParticipants: e.CALL_MAX_PARTICIPANTS,
    stunUrls: list(e.STUN_URLS),
    turnUrls: list(e.TURN_URLS),
    turnSecret: e.TURN_SECRET,
    turnTtlSeconds: e.TURN_TTL_SECONDS,
    logLevel: e.LOG_LEVEL,
  };
}
