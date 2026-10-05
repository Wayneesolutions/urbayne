import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { HttpError } from './http.js';

/** Counts hits per key in a fixed window. Shared across servers when backed by Redis. */
export interface RateStore {
  /** Records one hit and returns how many hits the key has in the current window. */
  hit(key: string, windowMs: number): Promise<number>;
}

export class MemoryRateStore implements RateStore {
  private hits = new Map<string, { n: number; reset: number }>();
  async hit(key: string, windowMs: number) {
    const t = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < t) { this.hits.set(key, { n: 1, reset: t + windowMs }); return 1; }
    return ++h.n;
  }
}

// INCR and the expiry are one atomic step, so a crash between them can never leave a key that never expires.
const HIT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

export class RedisRateStore implements RateStore {
  constructor(private redis: Redis, private prefix = 'rl') {}
  async hit(key: string, windowMs: number) {
    return Number(await this.redis.eval(HIT, 1, `${this.prefix}:${key}`, String(windowMs)));
  }
}

/**
 * Express limiter. If Redis is down it lets the request through (and logs): a Redis outage must not lock every voter out.
 * Abuse-sensitive routes keep their own database-backed limits (for example per-phone OTP requests).
 */
export function rateLimit(store: RateStore, max: number, windowMs: number): RequestHandler {
  return (req, _res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    store.hit(key, windowMs).then(
      (n) => next(n > max ? new HttpError(429, 'RATE_LIMITED') : undefined),
      (e) => { console.error('[rate-limit] store error, allowing request:', (e as Error).message); next(); },
    );
  };
}
