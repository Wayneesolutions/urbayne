/**
 * P0-2/3: Redis-backed rate limits, sessions, BullMQ call runs and row locking.
 * Needs Postgres (see other integration tests) and Redis: TEST_REDIS_URL=redis://localhost:6380/15  (pnpm redis:local)
 * Skipped when any of them is missing. Uses Redis database 15 and flushes it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { MockVoice } from '@cs/channels';
import { IN } from '@cs/regions';
import { schema, withTenant } from '@cs/db';
import { createApp, resolveDeps } from '../src/app.js';
import { createQueues, type Queues } from '../src/lib/queues.js';
import { RedisRateStore } from '../src/lib/rate-limit.js';
import { RedisSessions } from '../src/lib/sessions.js';
import { processRun } from '../src/modules/calls/runner.js';
import { sendShiftReminders } from '../src/modules/ops/routes.js';
import { testEnv } from './env.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const run = OWNER_URL && APP_URL && REDIS_URL ? describe : describe.skip;

const env = testEnv({ REDIS_URL });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

run('Redis: rate limits, sessions, queues, row locking (integration)', () => {
  let owner: pg.Pool;
  const pools: pg.Pool[] = [];
  const conns: Redis[] = [];
  const queuesList: Queues[] = [];
  const clock = () => new Date('2027-02-10T11:00:00+05:30'); // Wednesday 11:00 IST
  const newRedis = () => { const r = new Redis(REDIS_URL!, { maxRetriesPerRequest: null }); conns.push(r); return r; };

  /** One "server": its own database pool, Redis connection and queue handle, like a separate machine. */
  function server() {
    const pool = new pg.Pool({ connectionString: APP_URL, max: 6 });
    pools.push(pool);
    const redis = newRedis();
    const queues = createQueues(redis);
    queuesList.push(queues);
    const deps = resolveDeps({ env, pool, redis, queues, now: clock });
    return { deps, app: createApp(deps), queues };
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await newRedis().flushdb();
    await owner.query('TRUNCATE audit_log, shift_assignments, shifts, survey_responses, interactions, campaign_runs, consents, contacts, content_items, geo_areas, memberships, tenants, otp_codes, users CASCADE');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  // Rate-limit counters are per IP and every test here is the same IP, so start each test with clean counters.
  afterEach(async () => {
    const r = newRedis();
    const keys = await r.keys('rl:*');
    if (keys.length) await r.del(...keys);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all(queuesList.map((q) => q.close()));
    await Promise.all(pools.map((p) => p.end()));
    conns.forEach((c) => c.disconnect());
    await owner.end();
  });

  describe('rate limits', () => {
    it('count hits across servers and expire with the window', async () => {
      const a = new RedisRateStore(newRedis()), b = new RedisRateStore(newRedis());
      expect(await a.hit('k', 400)).toBe(1);
      expect(await b.hit('k', 400)).toBe(2);
      expect(await a.hit('k', 400)).toBe(3);
      await sleep(500);
      expect(await b.hit('k', 400)).toBe(1);
    });

    it('one IP cannot dodge the OTP limit by spreading requests over two servers', async () => {
      const s1 = server(), s2 = server();
      const codes: number[] = [];
      for (let i = 0; i < 22; i++) {
        const res = await request(i % 2 ? s1.app : s2.app).post('/api/auth/otp/request').send({ phone: `+9190000${String(10000 + i)}` });
        codes.push(res.status);
      }
      expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
      expect(codes.slice(20)).toEqual([429, 429]);
    });
  });

  describe('sessions', () => {
    it('are shared by servers; logout and logout-all end them for real', async () => {
      const a = server(), b = server();
      const login = async (phone: string) => {
        const r = await request(a.app).post('/api/auth/otp/request').send({ phone }).expect(200);
        return (await request(a.app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode }).expect(200)).body as { accessToken: string; refreshToken: string };
      };
      const t1 = await login('+919800000401');
      // Server B has never seen this login, yet accepts its refresh token.
      await request(b.app).post('/api/auth/refresh').send({ refreshToken: t1.refreshToken }).expect(200);

      await request(b.app).post('/api/auth/logout').send({ refreshToken: t1.refreshToken }).expect(200);
      const ended = await request(a.app).post('/api/auth/refresh').send({ refreshToken: t1.refreshToken }).expect(401);
      expect(ended.body.error).toBe('SESSION_ENDED');

      const t2 = await login('+919800000401');
      const t3 = await login('+919800000401');
      const all = await request(a.app).post('/api/auth/logout-all').set('Authorization', `Bearer ${t2.accessToken}`).expect(200);
      expect(all.body.ended).toBe(2);
      await request(b.app).post('/api/auth/refresh').send({ refreshToken: t2.refreshToken }).expect(401);
      await request(b.app).post('/api/auth/refresh').send({ refreshToken: t3.refreshToken }).expect(401);
    });

    it('a refresh token without a live session never works, and a forged one is refused', async () => {
      const a = server();
      const sessions = new RedisSessions(newRedis());
      expect(await sessions.isValid('nope', 'user')).toBe(false);
      await request(a.app).post('/api/auth/refresh').send({ refreshToken: 'garbage' }).expect(401);
    });
  });

  describe('call runs', () => {
    let tenantId = '', runId = '', auth: Record<string, string> = {};
    const N = 40;

    beforeAll(async () => {
      const s = server();
      const phone = '+919800000501';
      const r = await request(s.app).post('/api/auth/otp/request').send({ phone });
      const token = (await request(s.app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken as string;
      auth = { Authorization: `Bearer ${token}` };
      tenantId = (await request(s.app).post('/api/tenants').set(auth).send({ raceType: 'assembly', seatCode: 'Q-1', electionDate: '2027-02-20', campaignName: 'Queue Test', pollCloseAt: '2027-02-20T18:00:00+05:30' })).body.id;
      await owner.query('UPDATE tenants SET is_demo = true WHERE id = $1', [tenantId]);
      await request(s.app).patch(`/api/tenants/${tenantId}/settings`).set(auth).send({
        callingHoursOverride: { weekday: { start: 540, end: 1260 }, weekend: { start: 600, end: 1200 } }, slug: 'queue-test', candidateName: 'Q', officialInfoUrl: 'https://electoralsearch.eci.gov.in/',
      }).expect(200);
      const script = (await request(s.app).post(`/api/t/${tenantId}/content`).set(auth).send({
        kind: 'script', locale: 'pa', title: 'Survey', body: `${IN.aiDisclosure.spoken.pa} ਦੋ ਸਵਾਲ।`,
        survey: [{ key: 'q', question: 'Which issue matters most?', options: [{ value: 'a', label: 'A', dtmf: '1' }, { value: 'b', label: 'B', dtmf: '2' }] }],
      }).expect(201)).body.id;
      await request(s.app).post(`/api/t/${tenantId}/content/${script}/approve`).set(auth).send({ certificateNo: 'MCMC/Q/1' }).expect(200);
      for (let i = 0; i < N; i++) {
        await request(s.app).post(`/api/t/${tenantId}/contacts`).set(auth).send({
          phone: `+9198765${String(20000 + i)}`, source: 'form',
          consents: [{ purpose: 'survey', channel: 'voice', textVersion: 'v1', locale: 'pa', capturedVia: 'form' }],
        }).expect(201);
      }
      runId = (await request(s.app).post(`/api/t/${tenantId}/calls/runs`).set(auth).send({ name: 'Queue run', contentItemId: script, purpose: 'survey' })).body.id;
    });

    const status = async () => (await owner.query('SELECT status FROM campaign_runs WHERE id = $1', [runId])).rows[0].status as string;
    const resetRun = async () => {
      // The simulated first pass can make a contact say "stop" (random), which is correct but would block that person here.
      await owner.query('UPDATE contacts SET opted_out = false WHERE tenant_id = $1', [tenantId]);
      await owner.query('DELETE FROM suppressions WHERE tenant_id = $1', [tenantId]);
      await owner.query('UPDATE consents SET withdrawn_at = NULL WHERE tenant_id = $1', [tenantId]);
      await owner.query("UPDATE interactions SET status = 'queued', provider_ref = NULL, started_at = NULL, ended_at = NULL WHERE run_id = $1", [runId]);
      await owner.query("UPDATE campaign_runs SET status = 'running' WHERE id = $1", [runId]);
    };

    it('three workers on one run place every call exactly once (row locking)', async () => {
      const s = server();
      // Create the interactions (start with wait=true would also run it; use a first pass to seed rows, then reset).
      await request(s.app).post(`/api/t/${tenantId}/calls/runs/${runId}/start?wait=true`).set(auth).expect(200);
      expect(await status()).toBe('completed');
      await resetRun();

      const placed: string[] = [];
      const spy = vi.spyOn(MockVoice.prototype, 'startCall').mockImplementation(async function (this: MockVoice, req) {
        placed.push(req.metadata.interactionId);
        await sleep(5);
        return { provider: 'mock', providerRef: `m-${req.metadata.interactionId}`, status: 'completed', durationSec: 30, answers: { q: 'a' } };
      });
      const w1 = server().deps, w2 = server().deps, w3 = server().deps;
      await Promise.all([processRun(w1, tenantId, runId), processRun(w2, tenantId, runId), processRun(w3, tenantId, runId)]);
      spy.mockRestore();

      expect(placed.length).toBe(N);
      expect(new Set(placed).size).toBe(N); // no interaction was called twice
      expect(await status()).toBe('completed');
      const counts = (await owner.query("SELECT status, count(*)::int AS n FROM interactions WHERE run_id = $1 GROUP BY status", [runId])).rows;
      expect(counts).toEqual([{ status: 'completed', n: N }]);
    });

    it('BullMQ: starting a run enqueues ONE job, a worker finishes it, and a double kick is a no-op', async () => {
      await resetRun();
      await owner.query("DELETE FROM survey_responses WHERE tenant_id = $1", [tenantId]);
      const api = server();                      // the API server only enqueues
      const workerServer = server();             // a separate worker process
      const placed: string[] = [];
      const spy = vi.spyOn(MockVoice.prototype, 'startCall').mockImplementation(async (req) => {
        placed.push(req.metadata.interactionId);
        return { provider: 'mock', providerRef: `m-${req.metadata.interactionId}`, status: 'completed', durationSec: 20 };
      });
      const workers = workerServer.queues.startWorkers(workerServer.deps, { concurrency: 2 });
      await Promise.all([api.queues.enqueueRun(tenantId, runId), api.queues.enqueueRun(tenantId, runId)]);
      for (let i = 0; i < 100 && (await status()) !== 'completed'; i++) await sleep(100);
      spy.mockRestore();
      await Promise.all(workers.map((w) => w.close()));

      expect(await status()).toBe('completed');
      expect(placed.length).toBe(N);
      expect(new Set(placed).size).toBe(N);
    });

    it('a call claimed by a worker that died is closed as failed, never re-dialled', async () => {
      await resetRun();
      const [stuck] = (await owner.query("SELECT id FROM interactions WHERE run_id = $1 LIMIT 1", [runId])).rows;
      await owner.query("UPDATE interactions SET status = 'in_progress', started_at = $2 WHERE id = $1", [stuck.id, new Date(clock().getTime() - 30 * 60_000)]);
      const placed: string[] = [];
      const spy = vi.spyOn(MockVoice.prototype, 'startCall').mockImplementation(async (req) => {
        placed.push(req.metadata.interactionId);
        return { provider: 'mock', providerRef: `m-${req.metadata.interactionId}`, status: 'completed', durationSec: 10 };
      });
      await processRun(server().deps, tenantId, runId);
      spy.mockRestore();
      expect(placed).not.toContain(stuck.id);
      expect(placed.length).toBe(N - 1);
      const [row] = (await owner.query('SELECT status FROM interactions WHERE id = $1', [stuck.id])).rows;
      expect(row.status).toBe('failed');
      expect(await status()).toBe('completed');
    });

    it('shift reminders: two workers on one shift text each volunteer once', async () => {
      const s = server();
      const contacts = (await owner.query('SELECT id FROM contacts WHERE tenant_id = $1 LIMIT 6', [tenantId])).rows;
      const shift = (await owner.query("INSERT INTO shifts (tenant_id, title, starts_at) VALUES ($1, 'Booth duty', $2) RETURNING id", [tenantId, new Date('2027-02-12T08:00:00+05:30')])).rows[0].id;
      for (const c of contacts) {
        await owner.query("INSERT INTO shift_assignments (tenant_id, shift_id, contact_id) VALUES ($1,$2,$3)", [tenantId, shift, c.id]);
        await owner.query("INSERT INTO consents (tenant_id, contact_id, purpose, channel, text_version, locale, captured_via) VALUES ($1,$2,'reminder','sms','v1','pa','form')", [tenantId, c.id]);
      }
      const t = await withTenant(s.deps.pool, tenantId, async (db) => (await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)))[0]!);
      const [r1, r2] = await Promise.all([sendShiftReminders(s.deps, t, shift), sendShiftReminders(server().deps, t, shift)]);
      expect(r1.sent + r2.sent).toBe(6);
      const smsRows = (await owner.query("SELECT count(*)::int AS n FROM interactions WHERE tenant_id = $1 AND channel = 'sms'", [tenantId])).rows[0].n;
      expect(smsRows).toBe(6);
    });
  });
});
