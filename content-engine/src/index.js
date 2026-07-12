/**
 * Service bootstrap.
 *
 * Purpose:      Start content-engine: validate settings, run migrations, start
 *               the job runner, build the app, listen, and handle shutdown.
 * Dependencies: settings, core/db, core/jobRunner, app.
 */
import { settings } from './settings/index.js';
import { logger } from './core/logger.js';
import { runMigrations, closePool } from './core/db.js';
import * as jobRunner from './core/jobRunner.js';
import { createApp } from './app.js';

async function main() {
  logger.info({ env: settings.env, tz: settings.tz }, 'starting content-engine');

  await runMigrations();
  logger.info('migrations applied');

  const { app, shutdown } = createApp();
  jobRunner.start({ intervalMs: 5000, batch: 5 });

  const server = app.listen(settings.port, () => {
    logger.info({ port: settings.port }, 'content-engine listening');
  });

  const stop = async (signal) => {
    logger.info({ signal }, 'shutting down');
    jobRunner.stop();
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
