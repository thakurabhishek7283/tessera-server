import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifier } from '../src/auth/index.js';
import { createIds } from '../src/lib/ids.js';
import { testEnv } from './helpers.js';

let server: Server;
let jwksUrl: string;
let jwks: { keys: JWK[] };
let requests = 0;
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const keys: Record<string, PrivateKey> = {};

async function addKey(kid: string, alg: 'RS256' | 'ES256'): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  jwks.keys.push({ ...(await exportJWK(publicKey)), kid, alg, use: 'sig' });
  keys[kid] = privateKey;
}

const sign = (kid: string, alg: 'RS256' | 'ES256', claims: Record<string, unknown> = {}) =>
  new SignJWT({ sub: 'u1', name: 'Ada', ...claims })
    .setProtectedHeader({ alg, kid })
    .setExpirationTime('1h')
    .sign(keys[kid] as PrivateKey);

beforeAll(async () => {
  jwks = { keys: [] };
  await addKey('rsa-1', 'RS256');
  await addKey('ec-1', 'ES256');
  server = createServer((_req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('jwks mode', () => {
  const verifier = () =>
    createVerifier(testEnv({ AUTH_MODE: 'jwks', JWKS_URL: jwksUrl }), {
      clock: { now: () => new Date() },
      ids: createIds(),
    });

  it('verifies RS256 and ES256 tokens against the remote key set', async () => {
    const v = verifier();
    await expect(v.verify(await sign('rsa-1', 'RS256'))).resolves.toMatchObject({ id: 'u1' });
    await expect(v.verify(await sign('ec-1', 'ES256'))).resolves.toMatchObject({ name: 'Ada' });
  });

  it('caches the key set between verifications', async () => {
    const v = verifier();
    await v.verify(await sign('rsa-1', 'RS256'));
    const before = requests;
    await v.verify(await sign('rsa-1', 'RS256'));
    expect(requests).toBe(before);
  });

  it('rejects tokens signed by an unknown key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const rogue = await new SignJWT({ sub: 'evil' })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setExpirationTime('1h')
      .sign(privateKey);
    await expect(verifier().verify(rogue)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects HS256 tokens even when the kid exists (no alg confusion)', async () => {
    const hs = await new SignJWT({ sub: 'evil' })
      .setProtectedHeader({ alg: 'HS256', kid: 'rsa-1' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('secret'));
    await expect(verifier().verify(hs)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('requires a token and an exp claim', async () => {
    await expect(verifier().verify(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const noExp = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .sign(keys['rsa-1'] as PrivateKey);
    await expect(verifier().verify(noExp)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('reports an unreachable key set as UNAUTHORIZED, not a crash', async () => {
    const v = createVerifier(
      testEnv({ AUTH_MODE: 'jwks', JWKS_URL: 'http://127.0.0.1:1/jwks.json' }),
      { clock: { now: () => new Date() }, ids: createIds() },
    );
    await expect(v.verify(await sign('rsa-1', 'RS256'))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
