/** Monotonic millisecond clock; injectable for deterministic tests. */
export type NowMs = () => number;

/** Classic token bucket: `capacity` burst, refilled continuously at `refillPerSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: NowMs = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  /** Takes one token; false means the caller is over its rate and should be refused. */
  take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** True once the bucket is back to full, i.e. the caller has been idle long enough to forget. */
  get idle(): boolean {
    this.refill();
    return this.tokens >= this.capacity;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = t;
  }
}

/** Buckets keyed by string (e.g. `chat.send:<userId>`), shared across a user's connections. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private calls = 0;

  constructor(private readonly now: NowMs = () => performance.now()) {}

  take(key: string, capacity: number, refillPerSecond: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(capacity, refillPerSecond, this.now);
      this.buckets.set(key, bucket);
    }
    // Forget idle keys now and then so the map cannot grow without bound.
    if (++this.calls % 1000 === 0) this.prune();
    return bucket.take();
  }

  get size(): number {
    return this.buckets.size;
  }

  prune(): void {
    for (const [key, bucket] of this.buckets) if (bucket.idle) this.buckets.delete(key);
  }
}
