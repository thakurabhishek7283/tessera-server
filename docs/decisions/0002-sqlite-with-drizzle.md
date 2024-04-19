# 2. SQLite (better-sqlite3) with Drizzle ORM

Status: accepted

## Context

The server should start with `docker compose up` and no other services, hold chat history and
documents durably, and stay easy to move to another database later.

## Decision

Store everything in one SQLite file through `better-sqlite3`, in WAL mode with foreign keys on, and
access it with Drizzle ORM. Schema changes are generated SQL migrations committed to the repository
and applied when the database is opened. Documents keep their payload as a JSON text column and are
filtered with `json_extract`.

## Consequences

- Zero infrastructure: backup is a file copy, tests use `:memory:` and run in milliseconds.
- better-sqlite3 is synchronous, which keeps repository code simple and transactions short; it also
  means one writer at a time, acceptable for the intended scale.
- `better-sqlite3` is a native module, so the Docker build needs a toolchain in the build stage.
- Moving to Postgres later means a new Drizzle dialect and migrations; callers use repositories, not
  SQL, so the change stays inside `src/db` and the repositories.
