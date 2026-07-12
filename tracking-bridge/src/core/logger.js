/**
 * Structured JSON logger.
 *
 * Purpose:      Emit structured JSON log lines with a consistent shape across
 *               the whole service and every other service in the platform.
 * Responsibility:
 *               - Provide a base logger bound to the service name.
 *               - Provide child loggers that carry request correlation context
 *                 (request_id, tenant_id, module, endpoint) so every downstream
 *                 log line is automatically correlated.
 * Dependencies: pino, settings.
 *
 * Every log entry carries: time, service, level, and (when bound) request_id,
 * tenant_id, module, endpoint, duration, status, err.
 */
import pino from 'pino';
import { settings } from '../settings/index.js';

const base = pino({
  level: settings.logLevel,
  base: { service: settings.service },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/** The service-wide root logger. */
export const logger = base;

/**
 * Create a child logger bound to a request/job context.
 * @param {object} ctx - { request_id, tenant_id, module, endpoint }
 */
export function childLogger(ctx = {}) {
  return base.child(ctx);
}

export default logger;
