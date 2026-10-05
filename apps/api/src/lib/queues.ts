import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { processRun } from '../modules/calls/runner.js';
import { sendShiftReminders } from '../modules/ops/routes.js';
import type { Deps } from '../types.js';

export const QUEUE_PREFIX = 'cs';
export const RUN_QUEUE = 'call-runs';
export const REMINDER_QUEUE = 'reminders';

export interface RunJob { tenantId: string; runId: string }
export interface ReminderJob { tenantId: string; shiftId: string }

/** Background work. Jobs live in Redis, so they survive a restart and any server with workers can pick them up. */
export interface Queues {
  enqueueRun(tenantId: string, runId: string): Promise<void>;
  enqueueReminders(tenantId: string, shiftId: string): Promise<void>;
  /** Starts workers in this process. Call once, from the API process or from a dedicated worker process. */
  startWorkers(deps: Deps, opts?: { concurrency?: number }): Worker[];
  close(): Promise<void>;
}

const jobDefaults = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: true, // lets the same run be queued again after pause / resume
  removeOnFail: 100,
};

export function createQueues(connection: Redis): Queues {
  const runs = new Queue<RunJob>(RUN_QUEUE, { connection, prefix: QUEUE_PREFIX, defaultJobOptions: jobDefaults });
  const reminders = new Queue<ReminderJob>(REMINDER_QUEUE, { connection, prefix: QUEUE_PREFIX, defaultJobOptions: jobDefaults });
  const workers: Worker[] = [];

  return {
    // One waiting job per run: queueing an already-queued run is a no-op, never a second runner.
    async enqueueRun(tenantId, runId) { await runs.add('run', { tenantId, runId }, { jobId: `run-${runId}` }); },
    async enqueueReminders(tenantId, shiftId) { await reminders.add('remind', { tenantId, shiftId }, { jobId: `remind-${shiftId}` }); },

    startWorkers(deps, opts) {
      const concurrency = opts?.concurrency ?? 4;
      const w1 = new Worker<RunJob>(RUN_QUEUE, (job: Job<RunJob>) => processRun(deps, job.data.tenantId, job.data.runId),
        { connection: connection.duplicate(), prefix: QUEUE_PREFIX, concurrency });
      const w2 = new Worker<ReminderJob>(REMINDER_QUEUE, async (job: Job<ReminderJob>) => {
        const t = await withTenant(deps.pool, job.data.tenantId, async (db) => (await db.select().from(schema.tenants).where(eq(schema.tenants.id, job.data.tenantId)))[0]);
        if (t) await sendShiftReminders(deps, t, job.data.shiftId);
      }, { connection: connection.duplicate(), prefix: QUEUE_PREFIX, concurrency: 2 });
      for (const w of [w1, w2]) {
        w.on('failed', (job, err) => {
          deps.log.error({ queue: w.name, jobId: job?.id, attempt: job?.attemptsMade, err }, 'job failed');
          // Report only when the last attempt failed, not on every retry.
          if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) deps.reporter.capture(err, { job: `${w.name}:${job.id}`, tenantId: (job.data as { tenantId?: string }).tenantId });
        });
        w.on('error', (err) => deps.log.error({ queue: w.name, err }, 'worker error'));
        workers.push(w);
      }
      return [w1, w2];
    },

    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([runs.close(), reminders.close()]);
    },
  };
}
