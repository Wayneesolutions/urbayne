/**
 * Deletes personal data for every campaign past its retention date. Run it once a day from a scheduler
 * (cron, ECS scheduled task, EventBridge). Safe to run as often as you like: finished campaigns are skipped.
 *
 *   DATABASE_URL-style env as the API (APP_DATABASE_URL, PHONE_*_KEY, ...)  pnpm --filter @cs/api purge:due
 */
import { createPool } from '@cs/db';
import { loadEnv } from '../env.js';
import { purgeDueTenants } from '../modules/privacy/purge.js';

const env = loadEnv();
const pool = createPool(env.APP_DATABASE_URL);
const results = await purgeDueTenants({ env, pool });
console.log(results.length ? JSON.stringify(results, null, 2) : 'nothing due');
await pool.end();
process.exit(results.some((r) => r.error) ? 1 : 0);
