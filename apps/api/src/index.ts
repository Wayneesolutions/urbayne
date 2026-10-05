import { createPool } from '@cs/db';
import { loadEnv } from './env.js';
import { createApp, resolveDeps } from './app.js';
import { createRedis } from './lib/redis.js';
import { createQueues } from './lib/queues.js';

const env = loadEnv();
const pool = createPool(env.APP_DATABASE_URL);
const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : undefined;
const queues = redis ? createQueues(redis) : undefined;
const deps = resolveDeps({ env, pool, redis, queues });

const server = createApp(deps).listen(env.PORT, () =>
  console.log(`api (${env.DEPLOY_REGION}) on :${env.PORT}${redis ? ' [redis]' : ' [in-memory: one server only]'}`));
if (queues && env.RUN_WORKERS === 'true') {
  queues.startWorkers(deps, { concurrency: env.WORKER_CONCURRENCY });
  console.log('background workers started in this process');
}

async function shutdown() {
  server.close();
  await queues?.close();
  await pool.end();
  redis?.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
