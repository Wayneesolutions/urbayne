import type pg from 'pg';
import type { Env } from './env.js';
import type { Role, schema } from '@cs/db';

import type { Redis } from 'ioredis';
import type { RateStore } from './lib/rate-limit.js';
import type { SessionStore } from './lib/sessions.js';
import type { Queues } from './lib/queues.js';
import type { Logger } from 'pino';
import type { ErrorReporter } from './lib/observability.js';
import type { BlobStore } from './lib/storage.js';

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
  log?: Logger;
  reporter?: ErrorReporter;
  /** Where uploaded files are kept. Defaults to the driver chosen in the environment (local folder, or the region's S3 bucket). */
  store?: BlobStore;
  /** Outgoing HTTP for the road routing server (tests pass a stub). */
  fetch?: typeof fetch;
  /** Injectable clock (tests and demos). */
  now?: () => Date;
  /** Override channels (tests). */
  channels?: import('@cs/channels').ChannelEnv;
  /** Where password reset emails go. Defaults to SMTP when SMTP_URL is set, otherwise the log (development). Tests pass a MemoryMailer. */
  mailer?: import('./lib/mailer.js').Mailer;
}

export interface Deps extends DepsInit {
  rateStore: RateStore;
  sessions: SessionStore;
  log: Logger;
  reporter: ErrorReporter;
  store: BlobStore;
  mailer: import('./lib/mailer.js').Mailer;
}

export type EffectiveRole = Role | 'wes_admin';
export type TenantRow = typeof schema.tenants.$inferSelect;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Request id (also returned as X-Request-Id and attached to error reports). */
      id?: string;
      user?: { id: string; wes: boolean; sa: boolean };
      tenant?: TenantRow;
      role?: EffectiveRole;
    }
  }
}
