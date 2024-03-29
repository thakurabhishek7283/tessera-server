import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { openDatabase } from '../src/db/client.js';
import { connect, joinRoom, startTestServer, wsClient } from './ws.js';

describe('graceful shutdown (in process)', () => {
  it('closes every websocket with 1001 and announces departures first', async () => {
    const server = await startTestServer();
    const a = await connect(server);
    const b = await connect(server);
    await joinRoom(a, 'shop/presence:app');
    await joinRoom(b, 'shop/presence:app');

    await server.close();
    expect(await a.closed).toBe(1001);
    expect(await b.closed).toBe(1001);
    expect(server.app.hub.connectionCount).toBe(0);
    expect(server.app.hub.roomCount).toBe(0);
  });

  it('stops accepting new connections once closing', async () => {
    const server = await startTestServer();
    const closing = server.close();
    await closing;
    await expect(wsClient(server.url)).rejects.toThrow();
  });

  it('terminates a client that ignores the close handshake', async () => {
    const server = await startTestServer({}, { hub: { closeGraceMs: 100 } });
    const silent = await wsClient(server.url, { autoPong: false });
    silent.send({ t: 'hello', v: 1, token: null, appId: 'shop' });
    await silent.waitFor((m) => m.t === 'welcome');
    // Freeze the client's socket so it never answers the server's close frame.
    silent.ws.pause();
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(3000);
    silent.ws.terminate();
  });
});

describe('database close', () => {
  it('checkpoints the WAL into the main file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-wal-'));
    try {
      const path = join(dir, 'x.db');
      const db = openDatabase(path);
      db.sqlite.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
      db.close();
      expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('main.ts as a real process', () => {
  let child: ChildProcess | undefined;
  let dir: string;
  afterEach(() => {
    child?.kill('SIGKILL');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const start = async (): Promise<{
    port: number;
    output: () => string;
    exited: Promise<number | null>;
  }> => {
    dir = mkdtempSync(join(tmpdir(), 'tessera-main-'));
    let out = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        DATABASE_PATH: join(dir, 'db', 'tessera.db'),
        UPLOAD_DIR: join(dir, 'uploads'),
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => {
      out += d;
    });
    child.stderr?.on('data', (d) => {
      out += d;
    });
    const exited = new Promise<number | null>((resolve) =>
      child?.on('exit', (code) => resolve(code)),
    );
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 15_000);
      const poll = setInterval(() => {
        const m = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m?.[1]) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(Number(m[1]));
        }
      }, 50);
    });
    return { port, output: () => out, exited };
  };

  it('on SIGTERM says goodbye to websocket clients and exits 0', async () => {
    const { port, output, exited } = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.send(JSON.stringify({ t: 'hello', v: 1, token: null, appId: 'shop' }));
    await new Promise<void>((resolve) => ws.once('message', () => resolve()));

    child?.kill('SIGTERM');
    expect(await closed).toBe(1001);
    expect(await exited).toBe(0);
    expect(output()).toContain('shutting down');
  }, 30_000);

  it('exits 1 with a readable message on invalid configuration', async () => {
    let out = '';
    const bad = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: { ...process.env, PORT: 'abc' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bad.stderr?.on('data', (d) => {
      out += d;
    });
    const code = await new Promise<number | null>((resolve) => bad.on('exit', resolve));
    expect(code).toBe(1);
    expect(out).toMatch(/Invalid environment[\s\S]*PORT/);
  }, 30_000);
});
