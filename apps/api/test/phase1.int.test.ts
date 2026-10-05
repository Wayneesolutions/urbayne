/**
 * Phase 1 integration: demo call runs, compliance at send time, survey stats,
 * opt-outs, evidence pack, public hub, sign-up, assistant, share links.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { IN } from '@cs/regions';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const env: Env = {
  APP_DATABASE_URL: APP_URL ?? '', JWT_SECRET: 'test-secret-test-secret', JWT_REFRESH_SECRET: 'test-refresh-test-refresh',
  DEPLOY_REGION: 'IN', OTP_PROVIDER: 'console', PHONE_ENC_KEY: randomBytes(32).toString('base64'),
  PHONE_HASH_KEY: randomBytes(32).toString('base64'), PORT: 0, PUBLIC_BASE_URL: 'http://test.local', ANTHROPIC_MODEL: 'x', NODE_ENV: 'test', DEV_RETURN_OTP: 'false', FX_USD_TO_INR: 85, FX_USD_TO_CAD: 1.4,
};

run('Phase 1 (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  // Wednesday 11:00 IST, well before the silence window.
  let clock = new Date('2027-02-10T11:00:00+05:30');
  let token = '', tenant = '', script = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function login(phone: string) {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/api/auth/otp/request').send({ phone }).expect(200);
    const code = String(spy.mock.calls.at(-1)?.[0]).split('-> ')[1]!;
    spy.mockRestore();
    return (await request(app).post('/api/auth/otp/verify').send({ phone, code }).expect(200)).body.accessToken as string;
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, assistant_questions, share_links, survey_responses, interactions, campaign_runs, consents, contacts, content_items, geo_areas, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool, now: () => clock });
    token = await login('+919800000101');
    const t = await request(app).post('/api/tenants').set(auth()).send({
      raceType: 'assembly', seatCode: 'T-1', electionDate: '2027-02-20', campaignName: 'Test Candidate', pollCloseAt: '2027-02-20T18:00:00+05:30',
    }).expect(201);
    tenant = t.body.id;
    // Mark as demo directly (only Wayne E Solutions creates demo tenants).
    await owner.query('UPDATE tenants SET is_demo = true WHERE id = $1', [tenant]);
  });
  afterAll(async () => { await pool.end(); await owner.end(); });

  it('only demo tenants can set calling hours from the app', async () => {
    const other = await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'LIVE-1', electionDate: '2027-02-20', campaignName: 'Live' }).expect(201);
    const hours = { weekday: { start: 540, end: 1260 }, weekend: { start: 600, end: 1200 } };
    await request(app).patch(`/api/tenants/${other.body.id}/settings`).set(auth()).send({ callingHoursOverride: hours }).expect(403);
    await request(app).patch(`/api/tenants/${tenant}/settings`).set(auth()).send({
      callingHoursOverride: hours, slug: 'test-camp', candidateName: 'Test Candidate', officialInfoUrl: 'https://electoralsearch.eci.gov.in/',
    }).expect(200);
  });

  let areaA = '', areaB = '';
  it('sets up areas, a certified survey script and contacts', async () => {
    const root = await request(app).post(`/api/t/${tenant}/geo`).set(auth()).send({ level: 'constituency', nameEn: 'Test West' }).expect(201);
    areaA = (await request(app).post(`/api/t/${tenant}/geo`).set(auth()).send({ parentId: root.body.id, level: 'locality', nameEn: 'Model Town', namePa: 'ਮਾਡਲ ਟਾਊਨ' }).expect(201)).body.id;
    areaB = (await request(app).post(`/api/t/${tenant}/geo`).set(auth()).send({ parentId: root.body.id, level: 'locality', nameEn: 'Dugri' }).expect(201)).body.id;
    const s = await request(app).post(`/api/t/${tenant}/content`).set(auth()).send({
      kind: 'script', locale: 'pa', title: 'Survey', body: `${IN.aiDisclosure.spoken.pa} ਦੋ ਸਵਾਲ।`,
      survey: [{ key: 'top_issue', question: 'ਮੁੱਦਾ?', options: [{ value: 'water', label: 'ਪਾਣੀ', dtmf: '1' }, { value: 'roads', label: 'ਸੜਕਾਂ', dtmf: '2' }] }],
    }).expect(201);
    script = s.body.id;
    await request(app).post(`/api/t/${tenant}/content/${script}/approve`).set(auth()).send({ certificateNo: 'MCMC/T/1' }).expect(200);
    for (let i = 0; i < 30; i++) {
      await request(app).post(`/api/t/${tenant}/contacts`).set(auth()).send({
        phone: `+9198765${String(10000 + i)}`, source: 'form', geoAreaId: i % 2 ? areaA : areaB,
        consents: i === 3 ? [] : [{ purpose: 'survey', channel: 'voice', textVersion: 'v1', locale: 'pa', capturedVia: 'form' }],
      }).expect(201);
    }
  });

  let runId = '';
  it('blocks a run in the silence window, then runs it with per-call checks', async () => {
    runId = (await request(app).post(`/api/t/${tenant}/calls/runs`).set(auth()).send({ name: 'Issue survey', contentItemId: script, purpose: 'survey' }).expect(201)).body.id;
    clock = new Date('2027-02-19T12:00:00+05:30');
    const blocked = await request(app).post(`/api/t/${tenant}/calls/runs/${runId}/start`).set(auth()).expect(422);
    expect(blocked.body.reasons.map((r: { code: string }) => r.code)).toContain('SILENCE_WINDOW');

    clock = new Date('2027-02-10T11:00:00+05:30');
    const ok = await request(app).post(`/api/t/${tenant}/calls/runs/${runId}/start?wait=true`).set(auth()).expect(200);
    expect(ok.body.audience).toBe(30);

    const stats = (await request(app).get(`/api/t/${tenant}/calls/runs/${runId}/stats`).set(auth()).expect(200)).body;
    expect(stats.status).toBe('completed');
    expect(stats.total).toBe(30);
    expect(stats.counts.blocked).toBe(1);                 // the contact without consent
    expect(stats.blockedReasons.NO_CONSENT).toBe(1);
    const answered = stats.survey[0].options.reduce((s: number, o: { count: number }) => s + o.count, 0);
    expect(answered).toBeGreaterThan(0);
    expect(stats.survey[0].byArea.length).toBeGreaterThan(0);
  });

  it('never calls opted-out people again', async () => {
    const optOuts = await owner.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND opted_out', [tenant]);
    const run2 = (await request(app).post(`/api/t/${tenant}/calls/runs`).set(auth()).send({ name: 'Again', contentItemId: script, purpose: 'survey' }).expect(201)).body.id;
    const res = await request(app).post(`/api/t/${tenant}/calls/runs/${run2}/start?wait=true`).set(auth()).expect(200);
    expect(res.body.audience).toBe(30 - optOuts.rows[0].n);
  });

  it('exports an evidence pack with certificate and audit trail', async () => {
    const pack = (await request(app).get(`/api/t/${tenant}/calls/runs/${runId}/evidence`).set(auth()).expect(200)).body;
    expect(pack.content.certificateNo).toBe('MCMC/T/1');
    expect(pack.content.text.startsWith(IN.aiDisclosure.spoken.pa!)).toBe(true);
    expect(pack.auditTrail.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['create', 'start_blocked', 'start']));
    expect(pack.campaign.demo).toBe(true);
  });

  it('masks phone numbers in the call log', async () => {
    const rows = (await request(app).get(`/api/t/${tenant}/calls/runs/${runId}/interactions`).set(auth()).expect(200)).body;
    expect(rows[0].phone).toMatch(/\*{5}/);
  });

  it('public hub: profile, areas, area plan, sign-up with consent and share attribution', async () => {
    await request(app).post(`/api/t/${tenant}/content`).set(auth()).send({ kind: 'page', locale: 'en', title: 'Clean water', body: 'Water tests in every locality.' }).expect(201)
      .then((r) => request(app).post(`/api/t/${tenant}/content/${r.body.id}/approve`).set(auth()).send({}).expect(200));
    const prof = (await request(app).get('/api/public/test-camp').expect(200)).body;
    expect(prof.candidateName).toBe('Test Candidate');
    const areas = (await request(app).get('/api/public/test-camp/areas').expect(200)).body;
    expect(areas.map((a: { nameEn: string }) => a.nameEn)).toEqual(['Dugri', 'Model Town']);
    const plan = (await request(app).get(`/api/public/test-camp/areas/${areaA}?locale=en`).expect(200)).body;
    expect(plan.pages[0].title).toBe('Clean water');

    const link = (await request(app).post(`/api/t/${tenant}/share-links`).set(auth()).send({ label: 'Booth 1', geoAreaId: areaA }).expect(201)).body;
    const redirect = await request(app).get(`/s/${link.code}`).expect(302);
    expect(redirect.headers.location).toBe(`/v/test-camp?ref=${link.code}`);
    await request(app).get(`/api/t/${tenant}/share-links/${link.code}/qr.svg`).set(auth()).expect(200).expect('Content-Type', /svg/);

    await request(app).post('/api/public/test-camp/signup').send({ phone: '+919812300000', interests: ['volunteer'], caste: 'x' }).expect(400);
    await request(app).post('/api/public/test-camp/signup').send({
      phone: '+919812300000', name: 'New', areaId: areaA, interests: ['volunteer', 'updates'], consentCalls: true, locale: 'pa', ref: link.code,
    }).expect(201);
    const links = (await request(app).get(`/api/t/${tenant}/share-links`).set(auth()).expect(200)).body;
    expect(links[0]).toMatchObject({ clicks: 1, signups: 1 });
    const consents = await owner.query("SELECT count(*)::int AS n FROM consents c JOIN contacts p ON p.id = c.contact_id WHERE p.name = 'New' AND c.channel = 'voice'");
    expect(consents.rows[0].n).toBe(3);
  });

  it('shares only approved ad text', async () => {
    const draftAd = (await request(app).post(`/api/t/${tenant}/content`).set(auth()).send({ kind: 'ad', locale: 'pa', title: 'Ad', body: 'ਯੋਜਨਾ ਸੁਣੋ:' }).expect(201)).body.id;
    const link = (await request(app).post(`/api/t/${tenant}/share-links`).set(auth()).send({ label: 'Booth 2' }).expect(201)).body;
    await request(app).get(`/api/t/${tenant}/share-links/${link.code}/message?contentId=${draftAd}`).set(auth()).expect(422);
    await request(app).post(`/api/t/${tenant}/content/${draftAd}/approve`).set(auth()).send({ certificateNo: 'MCMC/T/2' }).expect(200);
    const msg = (await request(app).get(`/api/t/${tenant}/share-links/${link.code}/message?contentId=${draftAd}`).set(auth()).expect(200)).body;
    expect(msg.text).toContain(`http://test.local/s/${link.code}`);
  });

  it('assistant: answers from approved content, sends voting questions to the official site, hands off otherwise', async () => {
    const a = (await request(app).post('/api/public/test-camp/assistant/ask').send({ question: 'What about clean water?', locale: 'en' }).expect(200)).body;
    expect(a.outcome).toBe('answered');
    expect(a.source.title).toBe('Clean water');
    const v = (await request(app).post('/api/public/test-camp/assistant/ask').send({ question: 'Where is my polling booth?', locale: 'en' }).expect(200)).body;
    expect(v.outcome).toBe('official_link');
    expect(v.answer).toContain('electoralsearch.eci.gov.in');
    const h = (await request(app).post('/api/public/test-camp/assistant/ask').send({ question: 'Favourite cricket team?', locale: 'en' }).expect(200)).body;
    expect(h.outcome).toBe('handoff');
    const log = (await request(app).get(`/api/t/${tenant}/assistant`).set(auth()).expect(200)).body;
    expect(log.recent).toHaveLength(3);
  });

  it('webhook rejects calls without the shared secret', async () => {
    await request(app).post('/webhooks/vapi').send({ message: { type: 'end-of-call-report' } }).expect(401);
  });
});
