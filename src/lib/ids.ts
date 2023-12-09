import { randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';

/** Id generators, injectable so tests are deterministic. */
export interface Ids {
  /** Sortable, monotonic id (message ids, upload ids). */
  ulid(): string;
  /** Short opaque id for one websocket connection. */
  peer(): string;
  /** Suffix for anonymous guest users. */
  guest(): string;
}

/** Production id generators. */
export function createIds(): Ids {
  const ulid = monotonicFactory();
  const token = (bytes: number): string => randomBytes(bytes).toString('base64url');
  return {
    ulid: () => ulid(),
    peer: () => `p_${token(9)}`,
    guest: () => token(6),
  };
}

/** Wall-clock source, injectable so tests control time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
