/** Tunables for the websocket hub; the defaults are the documented production values. */
export interface HubOptions {
  /** A socket must send `hello` within this long or it is closed with 4001. */
  helloTimeoutMs: number;
  /** Interval between server-initiated ws ping frames. */
  heartbeatIntervalMs: number;
  /** A ping unanswered for this long terminates the connection. */
  pongTimeoutMs: number;
  /** Token bucket for all inbound frames of one connection. */
  bucketCapacity: number;
  bucketRefillPerSecond: number;
  /** Invalid frames tolerated per minute before the connection is closed with 4008. */
  maxInvalidFramesPerMinute: number;
  maxRoomsPerConnection: number;
}

export const DEFAULT_HUB_OPTIONS: HubOptions = {
  helloTimeoutMs: 5_000,
  heartbeatIntervalMs: 30_000,
  pongTimeoutMs: 10_000,
  bucketCapacity: 40,
  bucketRefillPerSecond: 20,
  maxInvalidFramesPerMinute: 10,
  maxRoomsPerConnection: 50,
};
