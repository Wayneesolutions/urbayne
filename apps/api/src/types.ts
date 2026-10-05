import type pg from 'pg';
import type { Env } from './env.js';
import type { Role, schema } from '@cs/db';

import type { Redis } from 'ioredis';
import type { RateStore } from './lib/rate-limit.js';
import type { SessionStore } from './lib/sessions.js';
import type { Queues } from './lib/queues.js';

/** What callers (index.ts, tests) pass in; createApp fills the rest with in-memory defaults. */
export interface DepsInit {
  env: Env;
  pool: pg.Pool;
  /** Shared Redis connection (rate limits, sessions, queues). Without it everything runs in memory, one server only. */
  redis?: Redis;
  rateStore?: RateStore;
  sessions?: SessionStore;
  /** Background job queues (BullMQ). Without them runs and reminders execute inline in this process. */
  queues?: Queues;
  /** Injectable clock (tests and demos). */
  now?: () => Date;
  /** Override channels (tests). */
  channels?: import('@cs/channels').ChannelEnv;
}

export interface Deps extends DepsInit {
  rateStore: RateStore;
  sessions: SessionStore;
}

export type EffectiveRole = Role | 'wes_admin';
export type TenantRow = typeof schema.tenants.$inferSelect;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; wes: boolean };
      tenant?: TenantRow;
      role?: EffectiveRole;
    }
  }
}
