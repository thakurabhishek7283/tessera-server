import { buildApp } from '../src/app.js';
import { type Env, parseEnv } from '../src/env.js';

/** Test env: in-memory database, quiet logs, overridable per test. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', ...overrides });
}

export async function testApp(overrides: Record<string, string> = {}) {
  return buildApp({ env: testEnv(overrides), logger: false });
}
