import { createHmac } from 'node:crypto';
import { IceRes } from '@tessera/protocol';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { authenticate } from '../../auth/http.js';
import type { Env } from '../../env.js';

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * Time-limited TURN credentials in coturn's "REST API" scheme (`use-auth-secret`): the username
 * is `<expiryUnix>:<userId>` and the credential is its HMAC-SHA1 under the shared secret, so
 * coturn can verify it without any user database and the credential dies by itself.
 */
export function turnCredentials(
  secret: string,
  userId: string,
  nowMs: number,
  ttlSeconds: number,
): { username: string; credential: string } {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiry}:${userId}`;
  return { username, credential: createHmac('sha1', secret).update(username).digest('base64') };
}

/** STUN servers from env, plus TURN with fresh credentials when `TURN_URLS`/`TURN_SECRET` are set. */
export function buildIceServers(env: Env, userId: string, nowMs: number): IceServer[] {
  const servers: IceServer[] = [];
  if (env.stunUrls.length > 0) servers.push({ urls: env.stunUrls });
  if (env.turnUrls.length > 0 && env.turnSecret) {
    servers.push({
      urls: env.turnUrls,
      ...turnCredentials(env.turnSecret, userId, nowMs, env.turnTtlSeconds),
    });
  }
  return servers;
}

/** `GET /v1/ice` — ICE servers for WebRTC calls. */
export const iceRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/ice',
    {
      schema: {
        response: { 200: IceRes },
        tags: ['calls'],
        summary: 'ICE servers (STUN, plus TURN with time-limited credentials)',
      },
    },
    async (req, reply) => {
      const user = await authenticate(app, req);
      // Credentials are per user and expire, so no intermediary may cache them.
      void reply.header('cache-control', 'no-store');
      return { iceServers: buildIceServers(app.env, user.id, app.clock.now().getTime()) };
    },
  );
};
