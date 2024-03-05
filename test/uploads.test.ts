import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadRes } from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, guest, testApp } from './helpers.js';

/** A real 3x2 RGBA PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAhNwEA3b0hxgAAAABJRU5ErkJggg==',
  'base64',
);

let app: Awaited<ReturnType<typeof testApp>>;
let dir: string;
let auth: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tessera-uploads-'));
  app = await testApp({ UPLOAD_DIR: dir, UPLOAD_MAX_BYTES: '2048' });
  auth = bearer((await guest(app)).token);
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

interface FileSpec {
  data: Buffer | string;
  filename?: string;
  type?: string;
  field?: string;
}

function multipartBody({
  data,
  filename = 'file.bin',
  type = 'application/octet-stream',
  field = 'file',
}: FileSpec) {
  const boundary = '----tessera-test';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.isBuffer(data) ? data : Buffer.from(data), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const upload = (spec: FileSpec, headers: Record<string, string> = auth) => {
  const { payload, headers: mp } = multipartBody(spec);
  return app.inject({
    method: 'POST',
    url: '/v1/uploads/shop',
    payload,
    headers: { ...headers, ...mp },
  });
};

describe('POST /v1/uploads/:appId', () => {
  it('stores an image, reads its size and returns a public URL', async () => {
    const res = await upload({ data: PNG, filename: 'pic.png', type: 'image/png' });
    expect(res.statusCode).toBe(201);
    const body = UploadRes.parse(res.json());
    expect(body).toMatchObject({ mime: 'image/png', size: PNG.length, width: 3, height: 2 });
    expect(body.url).toBe(`http://localhost:8787/uploads/${body.id}.png`);
    expect(readdirSync(dir)).toEqual([`${body.id}.png`]);
    expect(readFileSync(join(dir, `${body.id}.png`))).toEqual(PNG);

    const row = app.db.sqlite.prepare('SELECT * FROM uploads WHERE id = ?').get(body.id);
    expect(row).toMatchObject({ app_id: 'shop', mime: 'image/png', width: 3, height: 2 });
  });

  it('ignores the client file name when choosing the stored path', async () => {
    const res = await upload({ data: PNG, filename: '../../etc/passwd', type: 'image/png' });
    const body = UploadRes.parse(res.json());
    expect(readdirSync(dir)).toEqual([`${body.id}.png`]);
  });

  it('rejects types outside the allowlist', async () => {
    const res = await upload({ data: 'hello', filename: 'a.txt', type: 'text/plain' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION', details: { accept: expect.any(Array) } },
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects files over UPLOAD_MAX_BYTES with UPLOAD_TOO_LARGE', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(4096)]);
    const res = await upload({ data: big, type: 'image/png' });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({
      error: { code: 'UPLOAD_TOO_LARGE', details: { maxBytes: 2048 } },
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects images it cannot read', async () => {
    const res = await upload({ data: 'definitely not a png', type: 'image/png' });
    expect(res.statusCode).toBe(400);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('requires the file in a multipart field called "file"', async () => {
    const wrongField = await upload({ data: PNG, type: 'image/png', field: 'upload' });
    expect(wrongField.statusCode).toBe(400);
    const notMultipart = await app.inject({
      method: 'POST',
      url: '/v1/uploads/shop',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(notMultipart.statusCode).toBe(400);
  });

  it('enforces authentication and write access outside dev mode', async () => {
    const strict = await testApp({
      AUTH_MODE: 'secret',
      JWT_SECRET: 's'.repeat(32),
      UPLOAD_DIR: dir,
    });
    const { payload, headers } = multipartBody({ data: PNG, type: 'image/png' });
    const res = await strict.inject({ method: 'POST', url: '/v1/uploads/shop', payload, headers });
    expect(res.statusCode).toBe(401);
    await strict.close();
  });
});

describe('GET /uploads/:file', () => {
  const store = async (data: Buffer, type: string) => {
    const res = await upload({ data, type });
    const body = UploadRes.parse(res.json());
    return new URL(body.url).pathname;
  };

  it('serves images inline with long-lived caching and nosniff', async () => {
    const path = await store(PNG, 'image/png');
    const res = await app.inject({ method: 'GET', url: path });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('needs no authentication', async () => {
    const path = await store(PNG, 'image/png');
    const res = await app.inject({ method: 'GET', url: path, headers: {} });
    expect(res.statusCode).toBe(200);
  });

  it('answers 404 for unknown files, directory listings and traversal', async () => {
    expect((await app.inject({ method: 'GET', url: '/uploads/nope.png' })).statusCode).toBe(404);
    expect([403, 404]).toContain(
      (await app.inject({ method: 'GET', url: '/uploads/' })).statusCode,
    );
    const traversal = await app.inject({ method: 'GET', url: '/uploads/..%2Fpackage.json' });
    expect([403, 404]).toContain(traversal.statusCode);
    expect(traversal.body).not.toContain('tessera-server');
  });
});
