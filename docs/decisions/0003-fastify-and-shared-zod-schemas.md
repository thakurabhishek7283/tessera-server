# 3. Fastify, with request and response schemas shared through @tessera/protocol

Status: accepted

## Context

REST and WebSocket both need strict input validation, and the clients need the same types. The
OpenAPI document should not be written by hand.

## Decision

Use Fastify 5 with `fastify-type-provider-zod`. Every route declares zod schemas for params, query,
body and response, taken from `@tessera/protocol` wherever a client also uses them. The same
schemas validate WebSocket frames and `req` payloads (`TopicSchemas`). `@fastify/swagger` derives
the OpenAPI document from the route schemas.

## Consequences

- One definition per payload: server, client and docs cannot disagree silently.
- Responses are serialised through their schema, so accidental extra fields are not leaked.
- The protocol package becomes a build-time dependency of the server (see ADR 0004).
- zod models optional fields as `T | undefined`, which TypeScript does not accept as JSON; a small
  `asJson` helper marks the few places where DTOs are broadcast.
