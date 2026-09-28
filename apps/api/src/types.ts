import type pg from 'pg';
import type { Env } from './env.js';
import type { Role, schema } from '@cs/db';

export interface Deps {
  env: Env;
  pool: pg.Pool;
  /** Injectable clock (tests and demos). */
  now?: () => Date;
  /** Override channels (tests). */
  channels?: import('@cs/channels').ChannelEnv;
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
