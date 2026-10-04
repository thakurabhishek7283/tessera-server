# 1. A small custom WebSocket protocol instead of Socket.IO

Status: accepted

## Context

The Tessera kits need rooms, presence, broadcast, direct messages (WebRTC signalling) and
request/response calls over one connection. Socket.IO provides rooms and acknowledgements, but it
brings its own wire format, client library and reconnection semantics, and the kits must also work
with no server at all.

## Decision

Use plain WebSocket with JSON frames. The frames are defined once, as zod schemas in
`@tessera-kit/protocol`, and both the server and the client transport validate every frame against them.
The vocabulary is small: `hello`, `join`, `leave`, `pub`, `direct`, `presence`, `req`, `ping` from the
client; `welcome`, `joined`, `peer-join`, `peer-leave`, `presence`, `msg`, `res`, `error`, `pong` from
the server.

## Consequences

- The browser transport has no runtime dependency beyond `WebSocket`, and a local (BroadcastChannel)
  transport can mirror the same semantics for server-less demos.
- Types and validation are shared end to end; a malformed frame never reaches a handler.
- We own reconnection, heartbeats and backpressure (the client transport and the hub implement them)
  instead of inheriting them.
- Horizontal scaling is not free: the `Broker` interface marks where it would plug in.
