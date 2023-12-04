import { readFileSync } from 'node:fs';

interface PackageJson {
  version: string;
}

// Read at runtime so `dist/` and `src/` (tsx, vitest) report the same value.
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson;

/** Version of the running server, from package.json. */
export const VERSION: string = pkg.version;
