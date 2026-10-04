# 4. A single-package repository that links the protocol by tag

Status: accepted

## Context

Other Tessera repositories are pnpm workspaces. This repository ships one deployable application,
not a set of libraries, and it needs `@tessera-kit/protocol` from the `tessera` repository before that
package is published to npm.

## Decision

Keep one package (no workspace, Turborepo or Changesets: nothing here is published to npm). The
dependency on `@tessera-kit/protocol` is declared with a normal semver range and resolved during
development and CI through `pnpm.overrides` pointing at `external/tessera`, which
`scripts/fetch-deps.mjs` clones at the ref pinned in `deps.json` (or links from a sibling checkout)
and builds. The Docker build runs the same script, then replaces the link with a copy of the built
package so the runtime image contains only production dependencies.

## Consequences

- `pnpm deps` is one extra step before `pnpm install`; CI and Docker do it automatically.
- Moving to npm later removes the overrides, `deps.json`, the script and the Dockerfile copy step.
- The client packages (`@tessera-kit/core`, `transport`, `storage`) are linked the same way as dev
  dependencies, which is what lets the interop test run the real clients.
