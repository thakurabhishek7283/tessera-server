import { buildApp } from './app.js';
import { EnvError, parseEnv } from './env.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const app = await buildApp({ env });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
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
