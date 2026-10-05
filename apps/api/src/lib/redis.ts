import { Redis } from 'ioredis';

/** One connection per use. BullMQ needs maxRetriesPerRequest: null so workers wait for Redis instead of failing a job. */
export function createRedis(url: string): Redis {
  const r = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  r.on('error', (e) => console.error('[redis]', e.message));
  return r;
}
