import { GuestAuthBody, GuestAuthRes } from '@tessera-kit/protocol';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { SignJWT } from 'jose';
import { publicUser } from './verifier.js';

const GUEST_TTL_SECONDS = 24 * 60 * 60;

/**
 * `POST /v1/auth/guest` — mints a 24 h token for a display name so demos work with no identity
 * provider. Registered only when `AUTH_MODE=dev`; real deployments bring their own tokens.
 */
export const guestRoutes: FastifyPluginAsync = async (app) => {
  const { env } = app;
  const key = new TextEncoder().encode(env.jwtSecret);

  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/auth/guest',
    {
      schema: {
        body: GuestAuthBody,
        response: { 200: GuestAuthRes },
        tags: ['auth'],
        summary: 'Create a guest token (AUTH_MODE=dev only)',
      },
    },
    async (req) => {
      const id = `guest-${app.ids.guest()}`;
      const name = req.body.name.trim() || 'Guest';
      const iat = Math.floor(app.clock.now().getTime() / 1000);
      const token = await new SignJWT({ [env.claims.userId]: id, [env.claims.name]: name })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(iat)
        .setExpirationTime(iat + GUEST_TTL_SECONDS)
        .sign(key);
      const user = await app.verifier.verify(token);
      return { token, user: publicUser(user) };
    },
  );
};
