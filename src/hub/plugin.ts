import websocket from '@fastify/websocket';
import { CloseCode, MAX_FRAME_BYTES } from '@tessera/protocol';
import type { FastifyInstance } from 'fastify';
import type { Broker } from './broker.js';
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
  broker?: Broker,
): Promise<Hub> {
  const hub = new Hub(
    {
      verifier: app.verifier,
      authorizer: app.authorizer,
      ids: app.ids,
      clock: app.clock,
      db: app.db,
      callMaxParticipants: app.env.callMaxParticipants,
      ...(broker ? { broker } : {}),
    },
    { ...DEFAULT_HUB_OPTIONS, ...overrides },
  );
  app.decorate('hub', hub);

  // Registered before the websocket plugin's own preClose hook so clients get close code 1001
  // ("going away") rather than the library's code-less close.
  app.addHook('preClose', async () => {
    hub.closeAll(CloseCode.GoingAway, 'server shutting down');
  });

  // ws enforces maxPayload itself and closes with 1009 before our handler sees the frame.
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });

  // REST writes tell room members to refetch: `<appId>/docs:<collection>` is what
  // `RestStorage.watch` joins on the client.
  const stopBridge = app.events.onDocChanged(({ appId, event }) =>
    hub.broadcast(`${appId}/docs:${event.collection}`, 'doc.changed', event),
  );
  app.addHook('onClose', () => stopBridge());

  app.get('/v1/ws', { websocket: true }, (socket, req) => {
    hub.accept(socket, req.log);
  });
  return hub;
}
