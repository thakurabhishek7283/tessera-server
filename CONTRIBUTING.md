# Contributing

## Setup

Requires Node 22+ and pnpm 10 (`corepack enable` picks the pinned version).

```bash
pnpm deps     # clones and builds @tessera/protocol into ./external (git + network needed)
pnpm install
pnpm dev      # server on http://localhost:8787 with reload, API docs at /docs
pnpm check    # lint + typecheck + tests + build, the same as CI
```

If you have the `tessera` repository checked out next to this one, `pnpm deps` links it instead of
cloning, so protocol changes show up immediately (rebuild it with `pnpm build` over there).

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(chat): …`, `fix(hub): …`, `docs: …`, `test: …`, `chore: …`. Keep each commit green.
- **Formatting and linting** are handled by Biome: `pnpm format` fixes formatting, `pnpm lint` checks.
- **Validation**: every input is validated with zod; request and response schemas live in
  `@tessera/protocol` so the server and the clients share one definition.
- **Tests** run on Vitest against an in-memory SQLite database. Anything that touches the wire
  (REST or WebSocket) is tested through `fastify.inject` or a real `ws` client, not by calling
  internals. New behaviour needs a test; a bug fix needs a test that fails without the fix.
- **Database changes**: edit `src/db/schema.ts`, then `pnpm db:generate` to create the migration
  and commit the generated SQL.

## Layout

See [docs/architecture.md](docs/architecture.md) for how the hub, modules and storage fit together.
