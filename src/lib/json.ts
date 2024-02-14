import type { JsonValue } from '@tessera/protocol';
import { AppError } from './errors.js';

/** Field names allowed in `where`/`orderBy`; keeps them safe to embed in a JSON path. */
export const FIELD_NAME = /^[A-Za-z0-9_]{1,40}$/;

/** SQLite JSON path (`$.field`) for a top-level field, rejecting anything unexpected. */
export function jsonPath(field: string): string {
  if (!FIELD_NAME.test(field)) {
    throw new AppError('VALIDATION', `Invalid field name "${field}"`);
  }
  return `$.${field}`;
}

/** Parses a JSON column that this server wrote itself. */
export function parseStored<T = JsonValue>(text: string): T {
  return JSON.parse(text) as T;
}

/** Size in bytes of the JSON encoding of `value`. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Opaque pagination cursor wrapping a row offset. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

/** Inverse of {@link encodeCursor}; malformed cursors are a client error, not a crash. */
export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const offset = (parsed as { o?: unknown }).o;
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    // fall through to the error below
  }
  throw new AppError('VALIDATION', 'Invalid cursor');
}

/**
 * Narrows a value built from zod-inferred DTOs to `JsonValue`. zod models optional fields as
 * `T | undefined`, which TypeScript refuses as JSON even though `JSON.stringify` drops them.
 */
export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
