import { buildApp } from '../src/app.js';
import { type Env, parseEnv } from '../src/env.js';

/** Test env: in-memory database, quiet logs, overridable per test. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({ DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent', ...overrides });
}

export async function testApp(overrides: Record<string, string> = {}) {
  return buildApp({ env: testEnv(overrides), logger: false });
}

type App = Awaited<ReturnType<typeof testApp>>;

/** Mints a dev guest token through the public endpoint and returns it with the user id. */
export async function guest(app: App, name = 'Ada'): Promise<{ token: string; id: string }> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/guest', payload: { name } });
  const body = res.json<{ token: string; user: { id: string } }>();
  return { token: body.token, id: body.user.id };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
