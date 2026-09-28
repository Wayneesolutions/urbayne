import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type DB = NodePgDatabase<typeof schema>;

export function createPool(url: string) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/**
 * Run fn inside a transaction with app.tenant_id set, so Postgres RLS
 * limits every query to that tenant. Never query tenant data outside this.
 */
export async function withTenant<T>(pool: pg.Pool, tenantId: string | null, fn: (db: DB) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId ?? '']);
    const db = drizzle(client, { schema });
    const out = await fn(db);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
