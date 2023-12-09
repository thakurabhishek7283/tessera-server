import type { ERROR_CODES, JsonValue, WireError } from '@tessera/protocol';

/** Machine-readable error codes shared with clients (`@tessera/protocol`). */
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

/** HTTP status for an error code; anything unmapped is a 500. */
export function httpStatus(code: ErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

/** Builds the `{code, message, details?}` object used by both REST envelopes and WS frames. */
export function toWireError(code: ErrorCode, message: string, details?: JsonValue): WireError {
  return details === undefined ? { code, message } : { code, message, details };
}
