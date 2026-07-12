/**
 * Request context middleware.
 *
 * Purpose:      Attach a correlation id and resolved tenant to every request and
 *               emit a structured completion log line.
 * Responsibility:
 *               - Mint/propagate a request id (honors inbound X-Request-Id).
 *               - Resolve tenant from `/t/{tenant}` prefix or X-Tenant header.
 *               - Bind a child logger to req.log.
 *               - Log method, endpoint, status, and duration on finish.
 * Dependencies: logger, crypto.
 */
import { randomUUID } from 'node:crypto';
import { childLogger } from '../core/logger.js';

/** Correlation id + child logger. */
export function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * Resolve the tenant. A leading `/t/{tenant}` path segment wins, else the
 * X-Tenant header, else "default". When a path prefix is used it is stripped so
 * downstream routes match on their normal paths.
 */
export function tenantResolver(req, _res, next) {
  let tenant = req.headers['x-tenant'];
  const m = req.url.match(/^\/t\/([^/]+)(\/.*)?$/);
  if (m) {
    tenant = m[1];
    req.url = m[2] || '/';
  }
  req.tenantId = (tenant || 'default').toString();
  next();
}

/** Bind a child logger and log completion. */
export function requestLogger(req, res, next) {
  req.log = childLogger({
    request_id: req.requestId,
    tenant_id: req.tenantId,
    endpoint: `${req.method} ${req.path}`,
  });
  const started = Date.now();
  res.on('finish', () => {
    req.log.info(
      { status: res.statusCode, duration: Date.now() - started },
      'request complete',
    );
  });
  next();
}

export default { requestId, tenantResolver, requestLogger };
