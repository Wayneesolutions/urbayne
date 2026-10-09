/** Phase 4: agency view for political consultancies, with white-label branding. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor, emailFor } from './auth-helper.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

run('Agency view (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const tok: Record<string, string> = {};
  const T: Record<string, string> = {};
  const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const env = testEnv();

  async function login(phone: string) {
    const r = await ensureUser(app, phone);
    return (await tokenFor(app, phone)).body.accessToken as string;
  }
  async function campaign(who: string, seat: string, name: string, electionDate = '2027-02-20') {
    const id = (await request(app).post('/api/tenants').set(as(who)).send({ raceType: 'assembly', seatCode: seat, electionDate, campaignName: name })).body.id as string;
    T[seat] = id;
    return id;
  }
  const invite = async (who: string, tenant: string | undefined, whiteLabel = false) => (await request(app).post(`/api/t/${tenant}/agency/invite`).set(as(who)).send({ whiteLabel }).expect(201)).body.code as string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, agency_links, agency_invites, agency_members, agencies, contacts, finance_entries, content_items, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // One platform admin, two candidates, an agency administrator, agency staff and a stranger.
    for (const [k, p] of Object.entries({ wes: '+919800001001', cand1: '+919800001002', cand2: '+919800001003', agAdmin: '+919800001004', agStaff: '+919800001005', stranger: '+919800001006' })) {
      await login(p); // creates the user
      if (k === 'wes') await owner.query("UPDATE users SET is_wes_admin = true WHERE true AND id = (SELECT id FROM users ORDER BY created_at DESC LIMIT 1)");
      tok[k] = await login(p);
    }
    await campaign('cand1', 'AG-1', 'Campaign One', '2027-02-20');
    await campaign('cand2', 'AG-2', 'Campaign Two', '2027-03-01');
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  let agencyId = '';

  it('only platform staff can create an agency', async () => {
    const body = { name: 'Rajya Consulting', slug: 'rajya', brandName: 'Rajya Campaign Desk', primaryColor: '#1F4E79', supportEmail: 'help@rajya.example', adminEmail: emailFor('+919800001004') };
    await request(app).post('/api/admin/agencies').set(as('cand1')).send(body).expect(403);
    await request(app).post('/api/admin/agencies').set(as('wes')).send({ ...body, primaryColor: 'blue' }).expect(400);
    const a = (await request(app).post('/api/admin/agencies').set(as('wes')).send(body).expect(201)).body;
    agencyId = a.id;
    await request(app).post('/api/admin/agencies').set(as('wes')).send(body).expect(409);
    const mine = (await request(app).get('/api/agencies/mine').set(as('agAdmin')).expect(200)).body;
    expect(mine).toEqual([expect.objectContaining({ id: agencyId, role: 'admin', slug: 'rajya' })]);
    expect((await request(app).get('/api/agencies/mine').set(as('stranger')).expect(200)).body).toEqual([]);
  });

  it('the agency administrator manages the agency team; others cannot see it at all', async () => {
    await request(app).get(`/api/agencies/${agencyId}`).set(as('stranger')).expect(404);
    await request(app).post(`/api/agencies/${agencyId}/members`).set(as('agStaff')).send({ email: emailFor('+919800001005') }).expect(404);
    await request(app).post(`/api/agencies/${agencyId}/members`).set(as('agAdmin')).send({ email: emailFor('+919800001005'), role: 'staff' }).expect(201);
    await request(app).post(`/api/agencies/${agencyId}/members`).set(as('agAdmin')).send({ email: emailFor('+919800001005'), role: 'staff' }).expect(409);
    const a = (await request(app).get(`/api/agencies/${agencyId}`).set(as('agStaff')).expect(200)).body;
    expect(a.members).toHaveLength(2);
    expect(a.members.every((m: any) => m.email && !('phone' in m))).toBe(true); // names and emails, no phone numbers
    await request(app).patch(`/api/agencies/${agencyId}`).set(as('agStaff')).send({ name: 'Hijack' }).expect(403);
    await request(app).patch(`/api/agencies/${agencyId}`).set(as('agAdmin')).send({ supportEmail: 'new@rajya.example' }).expect(200);
    const admin = a.members.find((m: any) => m.role === 'admin');
    await request(app).delete(`/api/agencies/${agencyId}/members/${admin.userId}`).set(as('agAdmin')).expect(409); // the last administrator stays
  });

  it('a campaign owner links an agency with a one-time code', async () => {
    await request(app).post(`/api/t/${T['AG-1']}/agency/invite`).set(as('stranger')).send({}).expect(404);
    const code = await invite('cand1', T['AG-1']);
    expect(code).toMatch(/^AG-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(JSON.stringify(await q('SELECT * FROM agency_invites'))).not.toContain(code); // only a hash is kept
    await request(app).post(`/api/agencies/${agencyId}/link`).set(as('agStaff')).send({ code }).expect(403); // staff are not administrators
    await request(app).post(`/api/agencies/${agencyId}/link`).set(as('agAdmin')).send({ code: 'AG-WRONG-CODE1' }).expect(422);
    const ok = (await request(app).post(`/api/agencies/${agencyId}/link`).set(as('agAdmin')).send({ code: code.toLowerCase().replace(/-/g, ' ') }).expect(201)).body;
    expect(ok.tenantId).toBe(T['AG-1']);
    await request(app).post(`/api/agencies/${agencyId}/link`).set(as('agAdmin')).send({ code }).expect(422); // used once
    const second = await invite('cand2', T['AG-2']);
    await request(app).post(`/api/agencies/${agencyId}/link`).set(as('agAdmin')).send({ code: second }).expect(201);
  });

  it('the agency sees totals for each linked campaign: counts and money, nothing about a person', async () => {
    // Give campaign one some data to count.
    await request(app).patch(`/api/tenants/${T['AG-1']}/settings`).set(as('cand1')).send({ spendLimitMinor: 1_000_000 }).expect(200);
    await request(app).post(`/api/t/${T['AG-1']}/finance/entries`).set(as('cand1')).send({ kind: 'expense', entryDate: '2027-01-05', amountMinor: 950_000, category: 'Other', description: 'Hall', partyName: 'Hall Owner', billNo: 'H-1', paymentMode: 'bank' }).expect(201);
    await request(app).post(`/api/t/${T['AG-1']}/contacts`).set(as('cand1')).send({ phone: '+919811100001', name: 'Private Person', source: 'form' }).expect(201);
    await request(app).post(`/api/t/${T['AG-1']}/content`).set(as('cand1')).send({ kind: 'page', locale: 'en', title: 'Plan', body: 'Draft plan' }).expect(201);

    const o = (await request(app).get(`/api/agencies/${agencyId}/overview`).set(as('agStaff')).expect(200)).body;
    expect(o.campaigns.map((c: any) => c.seatCode)).toEqual(['AG-1', 'AG-2']); // soonest election first
    const c1 = o.campaigns[0];
    expect(c1).toMatchObject({ campaignName: 'Campaign One', contacts: 1, content: { drafts: 1 }, spending: { spentMinor: 950_000, limitMinor: 1_000_000, currency: 'INR' } });
    expect(c1.attention).toEqual(expect.arrayContaining(['SPENDING_NEAR_LIMIT', 'CONTENT_AWAITING_APPROVAL']));
    expect(typeof c1.daysToElection).toBe('number');
    // Nothing that identifies a person or reveals content reaches the agency.
    const raw = JSON.stringify(o);
    for (const secret of ['Private Person', '9811100001', 'Hall Owner', 'Draft plan']) expect(raw).not.toContain(secret);
    expect(o.attention).toBeGreaterThanOrEqual(2);
  });

  it("another agency or a stranger sees none of it; the link gives no access inside the campaign", async () => {
    await request(app).get(`/api/agencies/${agencyId}/overview`).set(as('stranger')).expect(404);
    await request(app).get(`/api/agencies/${agencyId}/overview`).set(as('cand1')).expect(404);
    await request(app).get(`/api/t/${T['AG-1']}/contacts`).set(as('agAdmin')).expect(404); // not on the campaign's team
    await request(app).get(`/api/t/${T['AG-1']}/finance/entries`).set(as('agStaff')).expect(404);
  });

  it('white-label: the campaign shows the agency brand to its own team, one agency at a time', async () => {
    const link = (await request(app).get(`/api/t/${T['AG-1']}/agency`).set(as('cand1')).expect(200)).body.links[0];
    expect((await request(app).get(`/api/t/${T['AG-1']}/agency/branding`).set(as('cand1')).expect(200)).body.agency).toBeNull();
    await request(app).patch(`/api/t/${T['AG-1']}/agency/${link.id}`).set(as('stranger')).send({ whiteLabel: true }).expect(404);
    await request(app).patch(`/api/t/${T['AG-1']}/agency/${link.id}`).set(as('cand1')).send({ whiteLabel: true }).expect(200);
    const b = (await request(app).get(`/api/t/${T['AG-1']}/agency/branding`).set(as('cand1')).expect(200)).body.agency;
    expect(b).toMatchObject({ brandName: 'Rajya Campaign Desk', primaryColor: '#1F4E79', supportEmail: 'new@rajya.example' });
    // A second agency cannot also become the brand.
    const other = (await request(app).post('/api/admin/agencies').set(as('wes')).send({ name: 'Other Agency', slug: 'other-agency', adminEmail: emailFor('+919800001006') }).expect(201)).body.id;
    const code = await invite('cand1', T['AG-1'], true);
    await request(app).post(`/api/agencies/${other}/link`).set(as('stranger')).send({ code }).expect(422);
  });

  it('the owner can revoke at any time; the agency then loses sight of the campaign', async () => {
    const link = (await request(app).get(`/api/t/${T['AG-1']}/agency`).set(as('cand1')).expect(200)).body.links[0];
    await request(app).post(`/api/t/${T['AG-1']}/agency/${link.id}/revoke`).set(as('cand1')).expect(200);
    await request(app).post(`/api/t/${T['AG-1']}/agency/${link.id}/revoke`).set(as('cand1')).expect(404);
    const o = (await request(app).get(`/api/agencies/${agencyId}/overview`).set(as('agAdmin')).expect(200)).body;
    expect(o.campaigns.map((c: any) => c.seatCode)).toEqual(['AG-2']);
    expect((await request(app).get(`/api/t/${T['AG-1']}/agency/branding`).set(as('cand1')).expect(200)).body.agency).toBeNull();
    expect((await q("SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'agency_%' ORDER BY id", [T['AG-1']])).map((r) => r.action)).toEqual(expect.arrayContaining(['agency_invite', 'agency_linked', 'agency_white_label', 'agency_revoked']));
  });

  it('an expired code does not work', async () => {
    const code = await invite('cand2', T['AG-2']);
    await owner.query("UPDATE agency_invites SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
    await request(app).post(`/api/agencies/${agencyId}/link`).set(as('agAdmin')).send({ code }).expect(422);
  });
});
