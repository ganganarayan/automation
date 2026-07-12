/**
 * Service bootstrap.
 *
 * Purpose:      Start the service: validate settings (on import), connect to the
 *               database, run migrations, start the job runner, build the app,
 *               and listen. Handles graceful shutdown.
 * Dependencies: settings, core/db, core/jobRunner, app.
 */
import { settings } from './settings/index.js';
import { logger } from './core/logger.js';
import { runMigrations, closePool } from './core/db.js';
import * as jobRunner from './core/jobRunner.js';
import { createApp } from './app.js';

async function main() {
  logger.info({ env: settings.env, tz: settings.tz }, 'starting wa-gateway');

  await runMigrations();
  logger.info('migrations applied');

  // Build the app (registers modules + their job handlers).
  const { app, shutdown } = createApp();

  // Start the durable job runner after handlers are registered.
  jobRunner.start({ intervalMs: 5000, batch: 5 });

  const server = app.listen(settings.port, () => {
    logger.info({ port: settings.port }, 'wa-gateway listening');
  });

  const stop = async (signal) => {
    logger.info({ signal }, 'shutting down');
    jobRunner.stop();
    await shutdown();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Failsafe.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal boot error');
  process.exit(1);
});
