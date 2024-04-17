// Mirrors the "Custom rules in code" example in the README, so it cannot drift from the API.
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthorizer } from '../src/auth/policy.js';
import { openDatabase } from '../src/db/client.js';
import { AppError } from '../src/lib/errors.js';
import { bearer, testEnv } from './helpers.js';

const sessions: Record<string, { userId: string; name: string; roles: string[] }> = {
  'session-editor': { userId: 'u1', name: 'Ed', roles: ['editor'] },
  'session-reader': { userId: 'u2', name: 'Rae', roles: [] },
};

describe('embedding with a custom verifier and authorizer', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => app.close());

  const make = async () => {
    const env = testEnv();
    const db = openDatabase(env.databasePath);
    app = await buildApp({
      env,
      db,
      logger: false,
      verifier: {
        async verify(token) {
          const session = token ? sessions[token] : undefined;
          if (!session) throw new AppError('UNAUTHORIZED', 'Unknown session');
          return {
            id: session.userId,
            name: session.name,
            roles: session.roles,
            anonymous: false,
            apps: null,
          };
        },
      },
      authorizer: {
        ...createAuthorizer(env, db),
        canWrite: (user) => user.roles?.includes('editor') ?? false,
      },
    });
    return db;
  };

  it('authenticates opaque tokens and applies the custom write rule', async () => {
    const db = await make();
    const put = (token: string) =>
      app.inject({
        method: 'PUT',
        url: '/v1/docs/shop/notes/n1',
        headers: bearer(token),
        payload: { data: { text: 'hi' } },
      });
    expect((await put('session-editor')).statusCode).toBe(200);
    expect((await put('session-reader')).statusCode).toBe(403);
    expect((await put('nobody')).statusCode).toBe(401);

    const read = await app.inject({
      method: 'GET',
      url: '/v1/docs/shop/notes/n1',
      headers: bearer('session-reader'),
    });
    expect(read.statusCode).toBe(200);
    // A caller-supplied database stays open after the app closes.
    await app.close();
    expect(db.sqlite.open).toBe(true);
    db.close();
  });
});
