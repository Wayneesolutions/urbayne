/** P0-8: paper and IVR consent evidence, suppression list, erasure and the post-election data deletion job. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { purgeDueTenants } from '../src/modules/privacy/purge.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor } from './auth-helper.js';
import { resolveDeps } from '../src/app.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const env = testEnv({ VAPI_WEBHOOK_SECRET: 'hook-secret-0123456789' });

run('Privacy: consent evidence and data deletion (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  let clock = new Date('2027-01-10T10:00:00Z');
  let token = '', tenantId = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const contact = (phone: string, extra: object = {}) => request(app).post(`/api/t/${tenantId}/contacts`).set(auth()).send({ phone, source: 'form', ...extra });
  const paper = (formNo?: string) => ({ purpose: 'survey', channel: 'voice', textVersion: 'paper-v1', locale: 'pa', capturedVia: 'paper', ...(formNo && { evidenceRef: formNo }) });

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, data_purges, suppressions, finance_entries, assistant_questions, door_visits, signs, shift_assignments, survey_responses, interactions, campaign_runs, consents, contacts, content_items, geo_areas, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool, now: () => clock });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await ensureUser(app, '+919800000601');
    token = (await tokenFor(app, '+919800000601')).body.accessToken;
    tenantId = (await request(app).post('/api/tenants').set(auth()).send({ raceType: 'assembly', seatCode: 'PV-1', electionDate: '2027-02-20', campaignName: 'Privacy Test' })).body.id;
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  describe('paper and IVR consent evidence', () => {
    it('paper consent needs the form number; it is stored with who captured it and when the person signed', async () => {
      const bad = await contact('+919811000001', { consents: [paper()] }).expect(422);
      expect(bad.body.error).toBe('CONSENT_EVIDENCE_REQUIRED');
      await contact('+919811000001', { consents: [{ ...paper('FORM-0042'), capturedAt: '2027-01-05' }] }).expect(201);
      const [c] = await q("SELECT * FROM consents WHERE captured_via = 'paper'");
      expect(c.evidence_ref).toBe('FORM-0042');
      expect(c.captured_by).toBeTruthy();
      expect(new Date(c.captured_at).toISOString().slice(0, 10)).toBe('2027-01-05');
      await contact('+919811000002', { consents: [{ ...paper('F-1'), capturedAt: '2999-01-01' }] }).expect(422);
    });

    it('IVR consent cannot be typed in by hand', async () => {
      const r = await contact('+919811000003', { consents: [{ ...paper(), capturedVia: 'ivr' }] }).expect(422);
      expect(r.body.error).toBe('IVR_CONSENT_IS_SYSTEM_ONLY');
    });

    it('a paper sheet records many people under one sheet number; repeats add no duplicate consent', async () => {
      const body = {
        sheetNo: 'SHEET-7', capturedAt: '2027-01-08', locale: 'pa', textVersion: 'paper-v1', purposes: ['info', 'survey'], channels: ['voice'],
        entries: [{ phone: '+919811000010', name: 'A' }, { phone: '+919811000011' }, { phone: '+919811000001' }, { phone: 'abc' }],
      };
      const res = (await request(app).post(`/api/t/${tenantId}/contacts/paper-sheet`).set(auth()).send(body).expect(201)).body;
      expect(res).toMatchObject({ created: 2, updated: 1, suppressed: 0 });
      expect(res.invalid).toEqual([{ row: 4, reason: 'BAD_PHONE' }]);
      const rows = await q("SELECT purpose, evidence_ref FROM consents WHERE evidence_ref = 'SHEET-7'");
      expect(rows).toHaveLength(5); // 2 new people x 2 purposes, plus 1 for the existing person (who already had an active survey consent: not duplicated)
      // Same sheet again: nothing new is written.
      await request(app).post(`/api/t/${tenantId}/contacts/paper-sheet`).set(auth()).send(body).expect(201);
      expect(await q("SELECT 1 FROM consents WHERE evidence_ref = 'SHEET-7'")).toHaveLength(5);
      await request(app).post(`/api/t/${tenantId}/contacts/paper-sheet`).set(auth()).send({ ...body, capturedAt: '2999-01-01' }).expect(422);
    });

    it('the provider webhook records IVR consent with the call as evidence, only when the consent text version is known', async () => {
      const [{ id: contactId }] = await q("SELECT id FROM contacts WHERE name = 'A'");
      const item = (await q("INSERT INTO content_items (tenant_id, kind, locale, title, body, status) VALUES ($1,'script','pa','s','b','approved') RETURNING id", [tenantId]))[0].id;
      const runId = (await q("INSERT INTO campaign_runs (tenant_id, name, channel, content_item_id, purpose, status) VALUES ($1,'R','voice',$2,'survey','running') RETURNING id", [tenantId, item]))[0].id;
      const call = async (consent: unknown) => {
        const i = (await q("INSERT INTO interactions (tenant_id, run_id, contact_id, channel, direction, status) VALUES ($1,$2,$3,'voice','outbound','in_progress') RETURNING id", [tenantId, runId, contactId]))[0].id;
        await request(app).post('/webhooks/vapi').set('x-vapi-secret', 'hook-secret-0123456789').send({
          message: { type: 'end-of-call-report', durationSeconds: 30, endedReason: 'hangup', call: { metadata: { tenantId, interactionId: i } },
            analysis: { structuredData: { locale: 'pa', answers: {}, consent } } },
        }).expect(200);
        return i as string;
      };
      await call({ purposes: ['reminder'] });                                   // no text version: no proof, nothing recorded
      expect(await q("SELECT 1 FROM consents WHERE captured_via = 'ivr'")).toHaveLength(0);
      const callId = await call({ purposes: ['reminder', 'donation', 'bogus'], textVersion: 'ivr-v1' });
      const rows = await q("SELECT purpose, channel, evidence_ref, text_version FROM consents WHERE captured_via = 'ivr'");
      expect(rows).toEqual([{ purpose: 'reminder', channel: 'voice', evidence_ref: callId, text_version: 'ivr-v1' }]); // never donation, never unknown purposes
    });
  });

  describe('suppression list', () => {
    it('opting out puts the number on the list, and the same number added again is created opted-out with no consents', async () => {
      const [{ id }] = await q("SELECT id FROM contacts WHERE name = 'A'");
      await owner.query('UPDATE contacts SET opted_out = true WHERE id = $1', [id]);
      expect(await q('SELECT 1 FROM suppressions WHERE tenant_id = $1', [tenantId])).toHaveLength(1);
      await owner.query('DELETE FROM contacts WHERE id = $1', [id]); // even if the contact row is gone
      const r = await contact('+919811000010', { consents: [paper('FORM-9')] }).expect(201);
      expect(r.body.suppressed).toBe(true);
      const [c] = await q("SELECT opted_out FROM contacts WHERE phone_hash = (SELECT phone_hash FROM suppressions LIMIT 1)");
      expect(c.opted_out).toBe(true);
      expect(await q('SELECT 1 FROM consents WHERE contact_id = (SELECT id FROM contacts WHERE opted_out LIMIT 1)')).toHaveLength(0);
    });
  });

  describe('erasure of one person', () => {
    it('deletes the contact, consents and what they said, keeps only the hash on the do-not-contact list', async () => {
      const [{ id }] = await q("SELECT id FROM contacts WHERE phone_hash <> (SELECT phone_hash FROM suppressions LIMIT 1) LIMIT 1");
      const run = (await q("SELECT id FROM campaign_runs LIMIT 1"))[0].id;
      await owner.query("INSERT INTO interactions (tenant_id, run_id, contact_id, channel, direction, status, transcript) VALUES ($1,$2,$3,'voice','outbound','completed','secret words')", [tenantId, run, id]);
      const res = await request(app).delete(`/api/t/${tenantId}/privacy/contacts/${id}`).set(auth()).expect(200);
      expect(res.body.counts.contacts).toBe(1);
      expect(res.body.counts.transcripts).toBe(1);
      expect(await q('SELECT 1 FROM contacts WHERE id = $1', [id])).toHaveLength(0);
      expect(await q('SELECT 1 FROM consents WHERE contact_id = $1', [id])).toHaveLength(0);
      expect(await q("SELECT 1 FROM interactions WHERE transcript = 'secret words'")).toHaveLength(0);
      expect(await q("SELECT 1 FROM suppressions WHERE reason = 'erasure_request'")).toHaveLength(1);
      expect(JSON.stringify(await q('SELECT counts FROM data_purges WHERE kind = $1', ['contact_erasure']))).not.toMatch(/\+91/);
      await request(app).delete(`/api/t/${tenantId}/privacy/contacts/${id}`).set(auth()).expect(404);
    });
  });

  describe('retention and the deletion job', () => {
    it('settings: retention days must be sensible, and the status shows when deletion happens', async () => {
      await request(app).patch(`/api/tenants/${tenantId}/settings`).set(auth()).send({ retentionDays: 2 }).expect(400);
      let s = (await request(app).get(`/api/t/${tenantId}/privacy`).set(auth()).expect(200)).body;
      expect(s.retentionConfigured).toBe(false);
      await request(app).patch(`/api/tenants/${tenantId}/settings`).set(auth()).send({ retentionDays: 30 }).expect(200);
      s = (await request(app).get(`/api/t/${tenantId}/privacy`).set(auth()).expect(200)).body;
      expect(s).toMatchObject({ retentionDays: 30, deleteOn: '2027-03-22', dueNow: false });
    });

    it('does nothing before the date, and refuses a bulk delete before the election is over', async () => {
      expect(await purgeDueTenants(resolveDeps({ env, pool, now: () => clock }))).toEqual([]);
      const r = await request(app).post(`/api/t/${tenantId}/privacy/purge`).set(auth()).send({ confirm: 'DELETE' }).expect(409);
      expect(r.body.error).toBe('ELECTION_NOT_OVER');
      await request(app).post(`/api/t/${tenantId}/privacy/purge`).set(auth()).send({}).expect(422);
    });

    it('after the retention date the job removes personal data but keeps results, finance and the suppression list', async () => {
      await owner.query("INSERT INTO assistant_questions (tenant_id, question, locale, outcome) VALUES ($1,'my address is 12 Main St','en','handoff')", [tenantId]);
      await owner.query("INSERT INTO signs (tenant_id, address) VALUES ($1,'12 Main St')", [tenantId]);
      await owner.query("INSERT INTO finance_entries (tenant_id, kind, entry_date, amount_minor, category, description, party_name) VALUES ($1,'expense','2027-02-01',5000,'Other','Posters','Print Shop')", [tenantId]);
      const [{ n: peopleBefore }] = await q('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenantId]);
      expect(peopleBefore).toBeGreaterThan(0);
      const suppressedBefore = (await q('SELECT 1 FROM suppressions WHERE tenant_id = $1', [tenantId])).length;

      clock = new Date('2027-03-23T00:00:00Z');
      const res = await purgeDueTenants(resolveDeps({ env, pool, now: () => clock }));
      expect(res).toHaveLength(1);
      expect(res[0]!.counts!.contacts).toBe(peopleBefore);

      expect(await q('SELECT 1 FROM contacts WHERE tenant_id = $1', [tenantId])).toHaveLength(0);
      expect(await q('SELECT 1 FROM consents WHERE tenant_id = $1', [tenantId])).toHaveLength(0);
      expect(await q('SELECT 1 FROM assistant_questions WHERE tenant_id = $1', [tenantId])).toHaveLength(0);
      expect((await q('SELECT address FROM signs WHERE tenant_id = $1', [tenantId]))[0].address).toBe('[removed]');
      expect(await q('SELECT 1 FROM interactions WHERE tenant_id = $1 AND (transcript IS NOT NULL OR contact_id IS NOT NULL)', [tenantId])).toHaveLength(0);
      expect(await q('SELECT 1 FROM finance_entries WHERE tenant_id = $1', [tenantId])).toHaveLength(1);       // election finance records stay
      expect((await q('SELECT 1 FROM suppressions WHERE tenant_id = $1', [tenantId])).length).toBeGreaterThanOrEqual(suppressedBefore);
      const [t] = await q('SELECT status, purged_at FROM tenants WHERE id = $1', [tenantId]);
      expect(t.status).toBe('archived');
      expect(t.purged_at).toBeTruthy();
      expect(await q("SELECT 1 FROM data_purges WHERE tenant_id = $1 AND kind = 'retention'", [tenantId])).toHaveLength(1);

      // Running again is harmless.
      expect(await purgeDueTenants(resolveDeps({ env, pool, now: () => clock }))).toEqual([]);
      const again = await request(app).post(`/api/t/${tenantId}/privacy/purge`).set(auth()).send({ confirm: 'DELETE' }).expect(409);
      expect(again.body.error).toBe('ALREADY_PURGED');
    });

    it('a campaign with no retention set is never deleted automatically', async () => {
      await owner.query('UPDATE tenants SET purged_at = NULL, retention_days = NULL, status = $2 WHERE id = $1', [tenantId, 'active']);
      clock = new Date('2030-01-01T00:00:00Z');
      expect(await purgeDueTenants(resolveDeps({ env, pool, now: () => clock }))).toEqual([]);
    });
  });
});
