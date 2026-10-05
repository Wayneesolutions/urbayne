/**
 * Dedicated background worker: call runs and reminders, no HTTP server.
 * Run as many of these as needed (pnpm --filter @cs/api worker); they share the Redis queues safely.
 * Set RUN_WORKERS=false on the API servers when using this.
 */
import { createPool } from '@cs/db';
import { loadEnv } from './env.js';
import { resolveDeps } from './app.js';
import { createRedis } from './lib/redis.js';
import { createQueues } from './lib/queues.js';
import { createReporter } from './lib/observability.js';

const env = loadEnv();
if (!env.REDIS_URL) throw new Error('REDIS_URL is required to run a worker');
const pool = createPool(env.APP_DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const queues = createQueues(redis);
const reporter = createReporter(env);
const deps = resolveDeps({ env, pool, redis, queues, reporter });
queues.startWorkers(deps, { concurrency: env.WORKER_CONCURRENCY });
console.log(`worker (${env.DEPLOY_REGION}) started, concurrency ${env.WORKER_CONCURRENCY}`);

async function shutdown() {
  await queues.close(); // lets the job in progress finish before exiting
  await reporter.flush();
  await pool.end();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
