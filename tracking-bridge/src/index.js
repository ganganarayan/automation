/**
 * Service bootstrap.
 *
 * Purpose:      Start tracking-bridge: validate settings, run migrations, build
 *               the app, listen, and handle shutdown.
 * Dependencies: settings, core/db, app.
 */
import { settings } from './settings/index.js';
import { logger } from './core/logger.js';
import { runMigrations, closePool } from './core/db.js';
import { createApp } from './app.js';

async function main() {
  logger.info({ env: settings.env, tz: settings.tz }, 'starting tracking-bridge');

  await runMigrations();
  logger.info('migrations applied');

  const { app, shutdown } = createApp();

  const server = app.listen(settings.port, () => {
    logger.info({ port: settings.port }, 'tracking-bridge listening');
  });

  const stop = async (signal) => {
    logger.info({ signal }, 'shutting down');
    await shutdown();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal boot error');
  process.exit(1);
});
