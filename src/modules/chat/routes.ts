import { ChatHistoryRes } from '@tessera/protocol';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticate } from '../../auth/http.js';
import type { ChatService } from './service.js';

const Params = z.object({
  appId: z.string().regex(/^[a-z0-9-]{1,40}$/),
  id: z.string().min(1).max(130),
});

const Query = z
  .object({
    before: z.string().min(1).max(64).optional(),
    after: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .refine((q) => !(q.before && q.after), { message: 'use either before or after, not both' });

/** REST mirror of `chat.history` for server-side rendering and host backends. */
export const chatRoutes =
  (service: ChatService): FastifyPluginAsync =>
  async (app) => {
    app.withTypeProvider<ZodTypeProvider>().get(
      '/v1/chat/:appId/conversations/:id/messages',
      {
        schema: {
          params: Params,
          querystring: Query,
          response: { 200: ChatHistoryRes },
          tags: ['chat'],
          summary: 'Message history of a conversation (mirror of chat.history)',
        },
      },
      async (req) => {
        const user = await authenticate(app, req);
        return service.history(user, req.params.appId, req.params.id, req.query);
      },
    );
  };
