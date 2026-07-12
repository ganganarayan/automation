/**
 * External-API HTTP client with retry.
 *
 * Purpose:      The single path every module uses to reach an external system.
 * Responsibility:
 *               - Wrap fetch with timeout, exponential backoff, retryable-status
 *                 detection, and structured logging.
 *               - Normalize failures into ExternalAPIError / RetryableError.
 * Dependencies: logger, errors.
 *
 * No module calls `fetch` against a third party directly; they call request()
 * (or a provider that uses it).
 */
import { logger } from './logger.js';
import { ExternalAPIError, RetryableError } from './errors.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Perform an HTTP request with retries.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {*} [options.body]              - object (JSON) | string | Buffer
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {string} [options.label]        - short name for logs
 * @param {import('pino').Logger} [options.log]
 * @param {(res: Response) => boolean} [options.retryOn] - custom retry predicate
 * @returns {Promise<{ ok: boolean, status: number, headers: Headers, data: any, text: string }>}
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    label = 'http',
    log = logger,
    retryOn,
  } = options;

  const finalHeaders = { ...headers };
  let payload = body;
  if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Buffer)) {
    payload = JSON.stringify(body);
    if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }
  }

  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      let data;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json') && text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }
      }

      const duration = Date.now() - started;
      const shouldRetry = retryOn ? retryOn(res) : RETRYABLE_STATUS.has(res.status);
      if (!res.ok && shouldRetry && attempt < retries) {
        log.warn({ label, url, method, status: res.status, duration, attempt }, 'external call retryable failure');
        lastErr = new RetryableError(`${label} responded ${res.status}`, { details: text?.slice(0, 500) });
        await sleep(backoff(attempt));
        attempt += 1;
        continue;
      }

      log.info({ label, url, method, status: res.status, duration, attempt }, 'external call complete');
      return { ok: res.ok, status: res.status, headers: res.headers, data, text };
    } catch (err) {
      clearTimeout(timer);
      const duration = Date.now() - started;
      const aborted = err?.name === 'AbortError';
      log.warn(
        { label, url, method, duration, attempt, err: err?.message, aborted },
        'external call error',
      );
      lastErr = aborted
        ? new RetryableError(`${label} timed out after ${timeoutMs}ms`, { cause: err })
        : new RetryableError(`${label} network error`, { cause: err });
      if (attempt < retries) {
        await sleep(backoff(attempt));
        attempt += 1;
        continue;
      }
      break;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new ExternalAPIError(`${label} failed after ${retries + 1} attempts`);
}

/** Exponential backoff with jitter (ms). */
function backoff(attempt) {
  const baseMs = 300 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(baseMs + jitter, 8000);
}

export default request;
