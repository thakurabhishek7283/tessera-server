import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Orm = ReturnType<typeof createOrm>;

function createOrm(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

/** An open SQLite database: the Drizzle ORM plus the raw handle for `json_extract` queries. */
export interface Db {
  orm: Orm;
  sqlite: Database.Database;
  close(): void;
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Opens the database (creating parent directories), applies pending migrations and returns it.
 * `:memory:` gives each caller an isolated database, which is what the tests use.
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // WAL lets readers proceed during a write; it is meaningless (and refused) for in-memory DBs.
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  const orm = createOrm(sqlite);
  migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  return { orm, sqlite, close: () => sqlite.close() };
}
