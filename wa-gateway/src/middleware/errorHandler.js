/**
 * Central error handler + 404.
 *
 * Purpose:      Map thrown errors to structured HTTP responses and logs.
 * Responsibility:
 *               - Convert AppError subclasses to their status/code.
 *               - Treat unknown errors as 500 without leaking internals.
 * Dependencies: errors, logger.
 */
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

/** 404 for unmatched routes. */
export function notFound(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

/** Express error-handling middleware (must have 4 args). */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const log = req?.log || logger;
  if (err instanceof AppError) {
    if (err.status >= 500) log.error({ err: err.message, code: err.code }, 'request error');
    else log.warn({ err: err.message, code: err.code }, 'request rejected');
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  log.error({ err: err?.message, stack: err?.stack }, 'unhandled error');
  return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
}

export default { notFound, errorHandler };
