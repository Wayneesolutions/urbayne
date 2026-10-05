import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const SESSION_TTL_SEC = 30 * 24 * 3600;

/** Refresh-token sessions. A refresh token is only good while its session exists, so logout and "sign out everywhere" really work. */
export interface SessionStore {
  create(userId: string): Promise<string>;
  isValid(sid: string, userId: string): Promise<boolean>;
  revoke(sid: string): Promise<void>;
  revokeAll(userId: string): Promise<number>;
}

export class MemorySessions implements SessionStore {
  private s = new Map<string, string>();
  async create(userId: string) { const sid = randomUUID(); this.s.set(sid, userId); return sid; }
  async isValid(sid: string, userId: string) { return this.s.get(sid) === userId; }
  async revoke(sid: string) { this.s.delete(sid); }
  async revokeAll(userId: string) {
    let n = 0;
    for (const [sid, u] of this.s) if (u === userId) { this.s.delete(sid); n++; }
    return n;
  }
}

export class RedisSessions implements SessionStore {
  constructor(private redis: Redis, private prefix = 'sess') {}
  private k = (sid: string) => `${this.prefix}:${sid}`;
  private u = (userId: string) => `${this.prefix}-user:${userId}`;
  async create(userId: string) {
    const sid = randomUUID();
    await this.redis.multi()
      .set(this.k(sid), userId, 'EX', SESSION_TTL_SEC)
      .sadd(this.u(userId), sid)
      .expire(this.u(userId), SESSION_TTL_SEC)
      .exec();
    return sid;
  }
  async isValid(sid: string, userId: string) { return (await this.redis.get(this.k(sid))) === userId; }
  async revoke(sid: string) {
    const userId = await this.redis.get(this.k(sid));
    const m = this.redis.multi().del(this.k(sid));
    if (userId) m.srem(this.u(userId), sid);
    await m.exec();
  }
  async revokeAll(userId: string) {
    const sids = await this.redis.smembers(this.u(userId));
    if (sids.length) await this.redis.del(...sids.map(this.k));
    await this.redis.del(this.u(userId));
    return sids.length;
  }
}
