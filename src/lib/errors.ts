import type { ERROR_CODES, JsonValue, WireError } from '@tessera-kit/protocol';

/** Machine-readable error codes shared with clients (`@tessera-kit/protocol`). */
export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
};

/** Error with a wire-level code; thrown by routes and handlers, rendered by the app error handler. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: JsonValue | undefined;

  constructor(code: ErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  /** HTTP status used when the error is returned from a REST route. */
  get status(): number {
    return httpStatus(this.code);
  }

  toWire(): WireError {
    return toWireError(this.code, this.message, this.details);
  }
}

/**
 * Optimistic-concurrency failure. REST returns the server's copy next to the error
 * (`ConflictBody`), which is where clients look for it.
 */
export class ConflictError extends AppError {
  constructor(
    message: string,
    readonly current: unknown,
  ) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

/** HTTP status for an error code; anything unmapped is a 500. */
export function httpStatus(code: ErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

/** Best error code for an HTTP status raised by Fastify or a plugin (not by our own code). */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'VALIDATION';
  }
}

/** Builds the `{code, message, details?}` object used by both REST envelopes and WS frames. */
export function toWireError(code: ErrorCode, message: string, details?: JsonValue): WireError {
  return details === undefined ? { code, message } : { code, message, details };
}
