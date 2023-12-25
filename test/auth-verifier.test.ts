import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createSecretVerifier, publicUser, userFromClaims } from '../src/auth/verifier.js';
import { type Clock, createIds } from '../src/lib/ids.js';
import { testEnv } from './helpers.js';

const SECRET = 'x'.repeat(40);
const NOW = new Date('2023-05-01T12:00:00Z');
const clock: Clock = { now: () => NOW };
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

async function sign(
  claims: Record<string, unknown>,
  opts: { secret?: string; exp?: number | null; alg?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
    .setIssuedAt(unix(NOW));
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? unix(NOW) + 3600);
  return jwt.sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

const secretEnv = (extra: Record<string, string> = {}) =>
  testEnv({ AUTH_MODE: 'secret', JWT_SECRET: SECRET, ...extra });

describe('secret mode', () => {
  const verifier = (extra?: Record<string, string>) =>
    createSecretVerifier(secretEnv(extra), { clock, ids: createIds() });

  it('maps standard claims to a user', async () => {
    const token = await sign({
      sub: 'u1',
      name: 'Ada',
      picture: 'https://img.test/a.png',
      roles: ['moderator'],
    });
    await expect(verifier().verify(token)).resolves.toEqual({
      id: 'u1',
      name: 'Ada',
      avatarUrl: 'https://img.test/a.png',
      roles: ['moderator'],
      anonymous: false,
      apps: null,
    });
  });

  it('honours custom claim names and the apps allowlist', async () => {
    const token = await sign({
      uid: 'u9',
      display: 'Bo',
      groups: 'admin',
      allowed: ['shop', 'blog'],
    });
    const user = await verifier({
      JWT_CLAIM_USER_ID: 'uid',
      JWT_CLAIM_NAME: 'display',
      JWT_CLAIM_ROLES: 'groups',
      JWT_CLAIM_APPS: 'allowed',
    }).verify(token);
    expect(user).toMatchObject({ id: 'u9', name: 'Bo', roles: ['admin'], apps: ['shop', 'blog'] });
  });

  it('falls back to the user id when there is no name claim', async () => {
    const user = await verifier().verify(await sign({ sub: 'u1' }));
    expect(user.name).toBe('u1');
  });

  it('rejects a missing token, a wrong secret and a tampered token', async () => {
    await expect(verifier().verify(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const forged = await sign({ sub: 'u1' }, { secret: 'y'.repeat(40) });
    await expect(verifier().verify(forged)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const good = await sign({ sub: 'u1' });
    await expect(verifier().verify(`${good.slice(0, -2)}xx`)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(verifier().verify('garbage')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects expired tokens and tokens without exp', async () => {
    const expired = await sign({ sub: 'u1' }, { exp: unix(NOW) - 10 });
    await expect(verifier().verify(expired)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const noExp = await sign({ sub: 'u1' }, { exp: null });
    await expect(verifier().verify(noExp)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects other algorithms (no alg confusion)', async () => {
    const hs512 = await sign({ sub: 'u1' }, { alg: 'HS512' });
    await expect(verifier().verify(hs512)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('enforces issuer and audience when configured', async () => {
    const v = verifier({ JWT_ISSUER: 'https://idp.test', JWT_AUDIENCE: 'tessera' });
    const plain = await sign({ sub: 'u1' });
    await expect(v.verify(plain)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const ok = await sign({ sub: 'u1', iss: 'https://idp.test', aud: 'tessera' });
    await expect(v.verify(ok)).resolves.toMatchObject({ id: 'u1' });
  });

  it('rejects tokens without a user id claim', async () => {
    await expect(verifier().verify(await sign({ name: 'No Id' }))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('dev mode', () => {
  const verifier = createSecretVerifier(testEnv({ JWT_SECRET: SECRET }), {
    clock,
    ids: createIds(),
  });

  it('turns a missing token into an anonymous guest', async () => {
    const user = await verifier.verify(null);
    expect(user).toMatchObject({ anonymous: true, apps: null });
    expect(user.id).toMatch(/^guest-/);
  });

  it('still rejects an invalid token instead of silently downgrading to guest', async () => {
    await expect(verifier.verify('nope')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts tokens without exp', async () => {
    const token = await sign({ sub: 'dev' }, { exp: null });
    await expect(verifier.verify(token)).resolves.toMatchObject({ id: 'dev' });
  });
});

describe('claim mapping', () => {
  const names = testEnv().claims;

  it('keeps only string roles and drops oversized values', () => {
    expect(userFromClaims({ sub: 'u', roles: ['a', 3, '', 'b'] }, names).roles).toEqual(['a', 'b']);
    expect(() => userFromClaims({ sub: 'x'.repeat(201) }, names)).toThrow(/acceptable/);
  });

  it('strips server-only fields from the public user', () => {
    const user = userFromClaims({ sub: 'u', tessera_apps: ['a'] }, names);
    expect(user.apps).toEqual(['a']);
    expect(publicUser(user)).toEqual({ id: 'u', name: 'u' });
  });
});
