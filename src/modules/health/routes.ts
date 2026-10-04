import { HealthRes } from '@tessera-kit/protocol';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { VERSION } from '../../version.js';

/** `GET /health` — liveness probe used by Docker and load balancers. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: { response: { 200: HealthRes }, tags: ['ops'], summary: 'Liveness probe' },
      config: { rateLimit: false },
    },
    async () => ({ ok: true as const, version: VERSION, uptime: process.uptime() }),
  );
};
