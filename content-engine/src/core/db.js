/**
 * Database access + migration runner.
 *
 * Purpose:      Own the Postgres connection pool and run additive, idempotent
 *               migrations on boot.
 * Responsibility:
 *               - Expose a shared pg Pool and query/transaction helpers.
 *               - Apply ordered .sql migration files exactly once, tracked in a
 *                 service-owned schema_migrations table.
 * Dependencies: pg, settings, logger.
 *
 * Migrations are additive only (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS). They never drop or rename columns automatically.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { settings } from '../settings/index.js';
import { logger } from './logger.js';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export const pool = new Pool({
  connectionString: settings.database.url,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'idle postgres client error');
});

// Errors on opening a connection that pass on their own: network errors just after
// the app wakes, and Postgres itself still waking from sleep or restarting
// (57P03 "the database system is starting up"). About 20 s in all.
const CONNECT_ERRORS = ['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', '57P03'];
const CONNECT_RETRY_MS = [500, 1500, 3000, 5000, 10000];

/** Get a connection, trying again on a network error. Nothing has run yet, so this is always safe. */
async function connect() {
  for (let i = 0; ; i += 1) {
    try {
      return await pool.connect();
    } catch (err) {
      if (i >= CONNECT_RETRY_MS.length || !CONNECT_ERRORS.includes(err.code)) throw err;
      logger.warn({ code: err.code, attempt: i + 1 }, 'postgres connect failed, trying again');
      await new Promise((resolve) => { setTimeout(resolve, CONNECT_RETRY_MS[i]); });
    }
  }
}

/** Run a parameterized query. */
export async function query(text, params) {
  const client = await connect();
  let failure;
  try {
    return await client.query(text, params);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    client.release(failure); // as pool.query does: a client that errored is not reused
  }
}

/** Run a function inside a transaction, committing on success. */
export async function withTransaction(fn) {
  const client = await connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Lightweight connectivity check for readiness probes. */
export async function ping() {
  await query('SELECT 1');
  return true;
}

/**
 * Apply all pending migrations in filename order. Each file runs once inside a
 * transaction; applied filenames are recorded in schema_migrations.
 */
export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    logger.info({ migration: file }, 'applied migration');
  }
}

/** Close the pool (graceful shutdown / tests). */
export async function closePool() {
  await pool.end();
}

export default pool;
