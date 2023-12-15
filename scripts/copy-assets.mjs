// tsc only emits .ts files; the SQL migrations must sit next to the compiled db/client.js.
import { cpSync } from 'node:fs';

cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
