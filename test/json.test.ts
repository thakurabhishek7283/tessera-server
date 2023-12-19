import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { createIds } from '../src/lib/ids.js';
import { decodeCursor, encodeCursor, jsonBytes, jsonPath } from '../src/lib/json.js';

describe('json helpers', () => {
  it('builds JSON paths only for safe field names', () => {
    expect(jsonPath('status')).toBe('$.status');
    for (const bad of ['', 'a.b', "x'; DROP", 'a b', 'x'.repeat(41)]) {
      expect(() => jsonPath(bad)).toThrow(AppError);
    }
  });

  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(150))).toBe(150);
    expect(decodeCursor(undefined)).toBe(0);
    expect(() => decodeCursor('not-a-cursor')).toThrow(/Invalid cursor/);
    expect(() => decodeCursor(Buffer.from('{"o":-1}').toString('base64url'))).toThrow(AppError);
  });

  it('measures UTF-8 bytes, not characters', () => {
    expect(jsonBytes('é')).toBe(4);
  });
});

describe('ids', () => {
  it('generates monotonic ULIDs even within one millisecond', () => {
    const { ulid } = createIds();
    const batch = Array.from({ length: 200 }, () => ulid());
    expect([...batch].sort()).toEqual(batch);
    expect(new Set(batch).size).toBe(200);
  });

  it('generates distinct peer and guest ids', () => {
    const ids = createIds();
    expect(ids.peer()).toMatch(/^p_[\w-]{12}$/);
    expect(ids.guest()).not.toBe(ids.guest());
  });
});
