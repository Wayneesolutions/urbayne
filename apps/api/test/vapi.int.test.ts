/** P0-5: Vapi adapter, end-of-call parsing, cost reconciliation and provider-side deletion. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { VapiVoice } from '@cs/channels';
import { createApp, resolveDeps } from '../src/app.js';
import { mapEndedReason, parseEndOfCall, sanitizeAnswers } from '../src/modules/calls/vapi-report.js';
import { reconcileCallCost } from '../src/modules/calls/cost.js';
import { purgeTenantData, deleteProviderCallData } from '../src/modules/privacy/purge.js';
import { testEnv } from './env.js';

const SECRET = 'vapi-hook-secret-0123456789';
const survey = [
  { key: 'top_issue', question: 'Which matters most?', options: [{ value: 'roads', label: 'Roads', dtmf: '1' }, { value: 'water', label: 'Water', dtmf: '2' }] },
  { key: 'vote', question: 'Will you vote?', options: [{ value: 'yes', label: 'Yes', dtmf: '1' }, { value: 'no', label: 'No', dtmf: '2' }] },
];

describe('endedReason mapping', () => {
  it('maps Vapi reasons to answered / not answered / failed', () => {
    for (const r of ['customer-did-not-answer', 'customer-busy', 'voicemail', 'silence-timed-out', 'assistant-join-timed-out']) expect(mapEndedReason(r)).toBe('no_answer');
    for (const r of ['hangup', 'customer-ended-call', 'assistant-ended-call', 'assistant-said-end-call-phrase', 'exceeded-max-duration']) expect(mapEndedReason(r)).toBe('completed');
    for (const r of ['call.start.error-subscription-insufficient-credits', 'call.start.error-vapi-number-outbound-daily-limit', 'twilio-failed-to-connect-call', 'assistant-not-found', 'call.in-progress.error-vapifault-worker-died', undefined]) expect(mapEndedReason(r)).toBe('failed');
  });
  it('an unknown reason is a failure unless the person clearly took part', () => {
    expect(mapEndedReason('some-new-reason')).toBe('failed');
    expect(mapEndedReason('some-new-reason', true)).toBe('completed');
    expect(mapEndedReason('some-new-error-reason', true)).toBe('failed');
  });
});

describe('parsing a report', () => {
  const meta = { tenantId: 'T', interactionId: 'I' };
  it('keeps only answers that match the survey that was asked', () => {
    expect(sanitizeAnswers(survey, { top_issue: 'roads', vote: 'maybe', invented: 'x' })).toEqual({ top_issue: 'roads' });
    expect(sanitizeAnswers(survey, null)).toEqual({});
    expect(sanitizeAnswers(null, { top_issue: 'roads' })).toEqual({});
  });

  it('reads a webhook message: ids, status, answers, stop request, transcript, cost (USD to micro-dollars)', () => {
    const p = parseEndOfCall({
      type: 'end-of-call-report', endedReason: 'customer-ended-call', cost: 0.1234, durationSeconds: 61.4,
      call: { id: 'call_1', metadata: meta }, artifact: { transcript: 'AI: hi User: roads' },
      analysis: { structuredData: { answers: { top_issue: 'roads' }, optOut: false } },
    }, survey);
    expect(p).toMatchObject({ tenantId: 'T', interactionId: 'I', providerRef: 'call_1', status: 'completed', durationSec: 61, answers: { top_issue: 'roads' }, optOut: false, costUsdMicros: 123400, transcript: 'AI: hi User: roads', hasRecording: false });
  });

  it('works on a call object from GET /call/{id} too, and finds the duration from the timestamps', () => {
    const p = parseEndOfCall({ id: 'call_2', status: 'ended', endedReason: 'customer-busy', cost: 0.05, startedAt: '2027-02-10T10:00:00Z', endedAt: '2027-02-10T10:00:42Z', metadata: meta }, survey);
    expect(p).toMatchObject({ providerRef: 'call_2', status: 'no_answer', durationSec: 42, costUsdMicros: 50000 });
  });

  it('falls back to the last message offset for the duration, and treats a cost of 0 as "not final yet"', () => {
    const p = parseEndOfCall({ endedReason: 'hangup', cost: 0, call: { metadata: meta }, artifact: { messages: [{ secondsFromStart: 3 }, { secondsFromStart: 27.2 }], recording: { url: 'x' } } });
    expect(p.durationSec).toBe(27);
    expect(p.costUsdMicros).toBeNull();
    expect(p.hasRecording).toBe(true);
  });

  it('survives an empty or odd payload without throwing', () => {
    expect(parseEndOfCall({}).status).toBe('failed');
    expect(parseEndOfCall(undefined as never).answers).toEqual({});
    expect(parseEndOfCall({ cost: 'abc', durationSeconds: 'x' }).costUsdMicros).toBeNull();
  });
});

describe('VapiVoice request', () => {
  const cfg = { apiKey: 'K', phoneNumberId: 'pn', assistantId: 'as', serverUrl: 'https://api.example.com/webhooks/vapi', webhookSecret: SECRET };
  const base = { to: '+919876543210', locale: 'pa', script: 'Disclosure and script.', survey, metadata: { tenantId: 't', interactionId: 'i', runId: 'r' } };

  it('sends the documented fields: server with secret, recording off, per-call structured data schema', () => {
    const b = new VapiVoice(cfg).buildRequest(base);
    expect(b).toMatchObject({ phoneNumberId: 'pn', assistantId: 'as', customer: { number: '+919876543210' } });
    expect(b.assistantOverrides.firstMessage).toBe('Disclosure and script.');
    expect(b.assistantOverrides.server).toEqual({ url: 'https://api.example.com/webhooks/vapi', secret: SECRET });
    expect(b.assistantOverrides.artifactPlan).toEqual({ recordingEnabled: false });
    expect(b.assistantOverrides.variableValues).toMatchObject({ locale: 'pa' });
    expect(b.assistantOverrides.variableValues.survey).toContain('Which matters most? 1: Roads, 2: Water');
    const schema = b.assistantOverrides.analysisPlan.structuredDataPlan.structuredDataSchema as any;
    expect(schema.required).toEqual(['answers', 'optOut']);
    expect(schema.properties.answers.properties.top_issue.enum).toEqual(['roads', 'water']);
    expect(schema.properties.consent).toBeUndefined();
  });

  it('recording is only on when asked for, and consent is only requested when the script asks for it', () => {
    expect(new VapiVoice({ ...cfg, recording: true }).buildRequest(base).assistantOverrides.artifactPlan).toEqual({ recordingEnabled: true });
    const b = new VapiVoice(cfg).buildRequest({ ...base, consent: { textVersion: 'ivr-v1', purposes: ['info', 'reminder'] } });
    const schema = b.assistantOverrides.analysisPlan.structuredDataPlan.structuredDataSchema as any;
    expect(schema.properties.consent.properties.purposes.items.enum).toEqual(['info', 'reminder']);
    expect(b.assistantOverrides.variableValues).toMatchObject({ consentTextVersion: 'ivr-v1' });
  });

  it('starts, reads, and deletes calls, and reports problems without throwing', async () => {
    const calls: { url: string; method?: string }[] = [];
    const f = (reply: (url: string, init?: any) => any) => (async (url: string, init?: any) => { calls.push({ url, method: init?.method }); return reply(url, init); }) as unknown as typeof fetch;
    const good = new VapiVoice(cfg, f(() => ({ ok: true, status: 200, json: async () => ({ id: 'call_9' }) })));
    expect(await good.startCall(base)).toEqual({ provider: 'vapi', providerRef: 'call_9', status: 'queued' });
    expect(await good.getCall('call_9')).toEqual({ id: 'call_9' });
    expect(await good.deleteCall('call_9')).toBe(true);
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.url}`)).toEqual(['POST https://api.vapi.ai/call', 'GET https://api.vapi.ai/call/call_9', 'DELETE https://api.vapi.ai/call/call_9']);

    expect((await new VapiVoice(cfg, f(() => ({ ok: false, status: 400 }))).startCall(base)).status).toBe('failed');
    expect((await new VapiVoice(cfg, f(() => ({ ok: true, json: async () => ({}) }))).startCall(base)).status).toBe('failed'); // no call id
    expect((await new VapiVoice(cfg, f(() => { throw new Error('network'); })).startCall(base)).status).toBe('failed');
    expect(await new VapiVoice(cfg, f(() => ({ ok: false, status: 404 }))).deleteCall('x')).toBe(true);  // already gone
    expect(await new VapiVoice(cfg, f(() => ({ ok: false, status: 500 }))).deleteCall('x')).toBe(false);
    expect(await new VapiVoice(cfg, f(() => ({ ok: false, status: 500 }))).getCall('x')).toBeNull();
  });
});

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('webhook, cost lookup and retention at the provider (integration)', () => {
  const env = testEnv({ VAPI_WEBHOOK_SECRET: SECRET, FX_USD_TO_INR: '85' });
  const channels = { vapi: { apiKey: 'K', phoneNumberId: 'pn', assistantId: 'as' } };
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>, deps: ReturnType<typeof resolveDeps>;
  let token = '', tenantId = '', runId = '', contentId = '', contactId = '';
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const fetchLog: { url: string; method: string }[] = [];
  let deleteStatus = 200;
  let callCost: number | undefined = 0.42;

  async function interaction(status = 'in_progress', providerRef: string | null = null) {
    return (await q("INSERT INTO interactions (tenant_id, run_id, contact_id, channel, direction, status, provider, provider_ref, content_item_id, started_at) VALUES ($1,$2,$3,'voice','outbound',$4,'vapi',$5,$6, now()) RETURNING id", [tenantId, runId, contactId, status, providerRef, contentId]))[0].id as string;
  }
  const report = (interactionId: string, message: object) => request(app).post('/webhooks/vapi').set('x-vapi-secret', SECRET)
    .send({ message: { type: 'end-of-call-report', call: { id: `call_${interactionId.slice(0, 6)}`, metadata: { tenantId, interactionId } }, ...message } });

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, data_purges, suppressions, finance_entries, survey_responses, interactions, campaign_runs, consents, contacts, content_items, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    deps = resolveDeps({ env, pool, channels });
    app = createApp(deps);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      fetchLog.push({ url, method });
      if (method === 'DELETE') return { ok: deleteStatus === 200, status: deleteStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: 'x', cost: callCost, status: 'ended', endedReason: 'customer-ended-call' }) };
    });
    const r = await request(app).post('/api/auth/otp/request').send({ phone: '+919800000901' });
    token = (await request(app).post('/api/auth/otp/verify').send({ phone: '+919800000901', code: r.body.devCode })).body.accessToken;
    tenantId = (await request(app).post('/api/tenants').set({ Authorization: `Bearer ${token}` }).send({ raceType: 'assembly', seatCode: 'VP-1', electionDate: '2027-02-20', campaignName: 'Vapi Test' })).body.id;
    contentId = (await q("INSERT INTO content_items (tenant_id, kind, locale, title, body, status, survey) VALUES ($1,'script','pa','s','b','approved',$2) RETURNING id", [tenantId, JSON.stringify(survey)]))[0].id;
    runId = (await q("INSERT INTO campaign_runs (tenant_id, name, channel, content_item_id, purpose, status, started_at) VALUES ($1,'R','voice',$2,'survey','running', now()) RETURNING id", [tenantId, contentId]))[0].id;
    const phoneHash = 'h'.repeat(64);
    contactId = (await q("INSERT INTO contacts (tenant_id, phone_hash, phone_enc, source) VALUES ($1,$2,'enc','form') RETURNING id", [tenantId, phoneHash]))[0].id;
  });
  afterAll(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('rejects a wrong secret, and ignores reports it cannot match (including non-UUID ids)', async () => {
    await request(app).post('/webhooks/vapi').set('x-vapi-secret', 'nope-nope-nope-nope').send({ message: { type: 'end-of-call-report' } }).expect(401);
    const ignored = await request(app).post('/webhooks/vapi').set('x-vapi-secret', SECRET).send({ message: { type: 'end-of-call-report', call: { metadata: { tenantId: 'verify', interactionId: 'verify-1' } } } }).expect(200);
    expect(ignored.body).toEqual({ ignored: true });
    await request(app).post('/webhooks/vapi').set('x-vapi-secret', SECRET).send({ message: { type: 'status-update' } }).expect(200);
  });

  it('records a completed call with only valid answers; a repeated report changes nothing', async () => {
    const id = await interaction();
    await report(id, { endedReason: 'customer-ended-call', durationSeconds: 55, cost: 0.2, transcript: 'hello', analysis: { structuredData: { answers: { top_issue: 'water', vote: 'maybe' }, optOut: false } } }).expect(200);
    const [row] = await q('SELECT status, duration_sec, cost_usd_micros, provider_ref FROM interactions WHERE id = $1', [id]);
    expect(row).toMatchObject({ status: 'completed', duration_sec: 55, cost_usd_micros: '200000' });
    expect(await q('SELECT question_key, answer_value FROM survey_responses WHERE interaction_id = $1', [id])).toEqual([{ question_key: 'top_issue', answer_value: 'water' }]);
    await report(id, { endedReason: 'customer-ended-call', durationSeconds: 99, analysis: { structuredData: { answers: { top_issue: 'roads' } } } }).expect(200);
    expect(await q('SELECT 1 FROM survey_responses WHERE interaction_id = $1', [id])).toHaveLength(1);
  });

  it('busy and voicemail are not answered; start errors are failures; neither records answers', async () => {
    for (const [reason, status] of [['customer-busy', 'no_answer'], ['voicemail', 'no_answer'], ['call.start.error-subscription-insufficient-credits', 'failed']] as const) {
      const id = await interaction();
      await report(id, { endedReason: reason, analysis: { structuredData: { answers: { top_issue: 'roads' } } } }).expect(200);
      expect((await q('SELECT status FROM interactions WHERE id = $1', [id]))[0].status).toBe(status);
      expect(await q('SELECT 1 FROM survey_responses WHERE interaction_id = $1', [id])).toHaveLength(0);
    }
  });

  it('"said stop" removes the person from future calls', async () => {
    const id = await interaction();
    await report(id, { endedReason: 'assistant-ended-call', analysis: { structuredData: { answers: {}, optOut: true } } }).expect(200);
    expect((await q('SELECT opted_out FROM contacts WHERE id = $1', [contactId]))[0].opted_out).toBe(true);
  });

  it('a cost of 0 in the report is looked up again at Vapi and charged to the campaign register', async () => {
    const id = await interaction('in_progress', 'call_cost_1');
    await report(id, { endedReason: 'customer-ended-call', cost: 0, durationSeconds: 30 }).expect(200);
    expect((await q('SELECT cost_usd_micros FROM interactions WHERE id = $1', [id]))[0].cost_usd_micros).toBeNull();
    expect(await reconcileCallCost(deps, tenantId, id)).toBe('updated');
    expect((await q('SELECT cost_usd_micros FROM interactions WHERE id = $1', [id]))[0].cost_usd_micros).toBe('420000');
    expect(fetchLog.some((f) => f.method === 'GET' && f.url.endsWith('/call/call_cost_1'))).toBe(true);
    const [entry] = await q("SELECT amount_minor FROM finance_entries WHERE source = 'call_run' AND source_ref = $1", [runId]);
    expect(Number(entry.amount_minor)).toBeGreaterThanOrEqual(3570); // 0.42 USD x 85 = Rs 35.70 (plus the earlier calls' cost)

    callCost = 0; // Vapi has not finalised billing yet
    const id2 = await interaction('completed', 'call_cost_2');
    expect(await reconcileCallCost(deps, tenantId, id2)).toBe('no_cost_yet');
    callCost = 0.42;
    expect(await reconcileCallCost(deps, tenantId, (await interaction('completed', null)))).toBe('skipped'); // no provider reference
  });

  it('after the retention purge, Vapi is asked to delete each finished call; failures are counted and can be retried', async () => {
    await owner.query("UPDATE interactions SET provider_ref = 'call_' || substr(id::text, 1, 8) WHERE provider_ref IS NULL AND status <> 'in_progress'");
    const finished = (await q("SELECT count(*)::int AS n FROM interactions WHERE provider = 'vapi' AND provider_ref IS NOT NULL AND status <> 'in_progress'"))[0].n;
    expect(finished).toBeGreaterThan(3);
    fetchLog.length = 0;
    deleteStatus = 500;
    const first = await purgeTenantData(deps, tenantId, { kind: 'owner_request' });
    expect(first && !first.alreadyPurged && first.providerData).toMatchObject({ deleted: 0, failed: finished });
    expect(fetchLog.filter((f) => f.method === 'DELETE')).toHaveLength(finished);

    deleteStatus = 200;
    fetchLog.length = 0;
    const retry = await request(app).post(`/api/t/${tenantId}/privacy/provider-data`).set({ Authorization: `Bearer ${token}` }).expect(200);
    expect(retry.body).toMatchObject({ deleted: finished, failed: 0, remaining: 0 });
    expect(await q('SELECT 1 FROM interactions WHERE provider_ref IS NOT NULL AND status <> $1 AND provider_data_deleted_at IS NULL', ['in_progress'])).toHaveLength(0);
    // Nothing left: a third run does not call Vapi again.
    fetchLog.length = 0;
    expect(await deleteProviderCallData(deps, tenantId)).toEqual({ deleted: 0, failed: 0, remaining: 0 });
    expect(fetchLog).toHaveLength(0);
  });
});
