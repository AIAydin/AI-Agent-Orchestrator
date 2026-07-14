interface RateBucket {
  count: number;
  resetsAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private operations = 0;

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.operations += 1;
    if (this.operations % 1_000 === 0) this.sweep(now);

    const existing = this.buckets.get(key);
    const bucket =
      !existing || existing.resetsAt <= now
        ? { count: 0, resetsAt: now + this.windowMs }
        : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: bucket.count <= this.maximum,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetsAt - now) / 1_000)),
    };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetsAt <= now) this.buckets.delete(key);
    }
  }
}
