/**
 * Error taxonomy.
 *
 * Purpose:      Provide a small set of typed error classes so callers can react
 *               to failure categories instead of parsing error strings, and so
 *               the central error handler can map them to HTTP responses.
 * Responsibility:
 *               - Define domain-agnostic error types shared by every module.
 *               - Carry an HTTP status, a stable `code`, and optional details.
 * Dependencies: none.
 *
 * Business code never throws a bare Error; it throws one of these.
 */

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts] - { status, code, details, retryable, cause }
   */
  constructor(message, { status = 500, code = 'internal_error', details, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Input failed validation (bad request). */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details) {
    super(message, { status: 400, code: 'validation_error', details });
  }
}

/** Caller is not authenticated / provided a bad key. */
export class AuthenticationError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, { status: 401, code: 'authentication_error' });
  }
}

/** A resource was not found. */
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { status: 404, code: 'not_found' });
  }
}

/** A downstream/external API call failed. */
export class ExternalAPIError extends AppError {
  constructor(message = 'External API error', { status = 502, details, retryable = false, cause } = {}) {
    super(message, { status, code: 'external_api_error', details, retryable, cause });
  }
}

/** A transient failure the caller may retry. */
export class RetryableError extends AppError {
  constructor(message = 'Temporary failure', { details, cause } = {}) {
    super(message, { status: 503, code: 'retryable_error', details, retryable: true, cause });
  }
}

/** A permanent failure that must not be retried. */
export class PermanentError extends AppError {
  constructor(message = 'Permanent failure', { details, cause } = {}) {
    super(message, { status: 422, code: 'permanent_error', details, retryable: false, cause });
  }
}

export default AppError;
