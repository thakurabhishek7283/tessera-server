import { buildApp } from './app.js';
import { EnvError, parseEnv } from './env.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = parseEnv();
  const app = await buildApp({ env });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Stop accepting, say goodbye to websocket clients (1001), then flush the database.
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ port: env.port, host: env.host });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (env failed to parse), so write straight to stderr.
  process.stderr.write(`${err instanceof EnvError ? err.message : String(err)}\n`);
  process.exit(1);
});
