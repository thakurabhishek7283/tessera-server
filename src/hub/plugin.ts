import websocket from '@fastify/websocket';
import { MAX_FRAME_BYTES } from '@tessera/protocol';
import type { FastifyInstance } from 'fastify';
import { Hub } from './hub.js';
import { DEFAULT_HUB_OPTIONS, type HubOptions } from './options.js';

declare module 'fastify' {
  interface FastifyInstance {
    hub: Hub;
  }
}

/** Mounts `GET /v1/ws` and decorates the app with the {@link Hub}. */
export async function registerHub(
  app: FastifyInstance,
  overrides: Partial<HubOptions> = {},
): Promise<Hub> {
  // ws enforces maxPayload itself and closes with 1009 before our handler sees the frame.
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });

  const hub = new Hub(
    {
      verifier: app.verifier,
      authorizer: app.authorizer,
      ids: app.ids,
      clock: app.clock,
      callMaxParticipants: app.env.callMaxParticipants,
    },
    { ...DEFAULT_HUB_OPTIONS, ...overrides },
  );
  app.decorate('hub', hub);

  app.get('/v1/ws', { websocket: true }, (socket, req) => {
    hub.accept(socket, req.log);
  });
  return hub;
}
