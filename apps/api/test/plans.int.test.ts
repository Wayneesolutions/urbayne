/** Phase 5: pricing packages, usage metering, limits and per-campaign invoicing. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { withTenant } from '@cs/db';
import { createApp } from '../src/app.js';
import { buildPlanInvoice, billedUnits, type PlanSub } from '../src/modules/billing/invoice.js';
import { planLimitReached, usageWindow } from '../src/modules/billing/metering.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor, emailFor } from './auth-helper.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;

const terms = { included: { smsSent: 1000, callMinutes: 500 }, overageMinor: { smsSent: 20, callMinutes: 300, assistantQuestions: 5 }, hardLimits: { callMinutes: 600, teamMembers: 3 } };
const sub = (over: Partial<PlanSub> = {}): PlanSub => ({ plan: 'Assembly package', billing: 'per_campaign', priceMinor: 5_000_000, taxPercent: null, discountPercent: null, startedOn: '2027-01-10', terms, ...over });

describe('buildPlanInvoice', () => {
  it('a per-campaign package bills its price once, in the month it starts', () => {
    expect(buildPlanInvoice(sub(), '2027-01', {}).lines).toEqual([{ description: 'Assembly package: campaign package', quantity: 1, unitMinor: 5_000_000, amountMinor: 5_000_000 }]);
    expect(buildPlanInvoice(sub(), '2027-02', {}).lines).toEqual([]);
    expect(buildPlanInvoice(sub(), '2026-12', { smsSent: 5000 }).lines).toEqual([]); // before it started
  });
  it('bills only the units beyond what is included, and never the same unit twice', () => {
    const first = buildPlanInvoice(sub(), '2027-01', { smsSent: 1200, callMinutes: 400 });
    expect(first.lines.map((l) => [l.metric, l.quantity, l.amountMinor])).toEqual([[undefined, 1, 5_000_000], ['smsSent', 200, 4000]]);
    const second = buildPlanInvoice(sub(), '2027-02', { smsSent: 1500, callMinutes: 650 }, billedUnits([{ status: 'issued', lines: first.lines }]));
    expect(second.lines.map((l) => [l.metric, l.quantity])).toEqual([['smsSent', 300], ['callMinutes', 150]]); // cumulative minus what the first invoice billed
    expect(second.totalMinor).toBe(300 * 20 + 150 * 300);
    // A voided invoice does not count as billed.
    expect(billedUnits([{ status: 'void', lines: first.lines }])).toEqual({});
  });
  it('a monthly package prices pro rata in the first month and measures each month on its own', () => {
    const m = sub({ billing: 'monthly', priceMinor: 310_000, startedOn: '2027-01-16' });
    expect(buildPlanInvoice(m, '2027-01', {}).lines[0]).toMatchObject({ description: 'Assembly package, 2027-01 (16 of 31 days)', amountMinor: 160_000 });
    const feb = buildPlanInvoice(m, '2027-02', { smsSent: 1100 });
    expect(feb.lines.map((l) => [l.metric, l.quantity])).toEqual([[undefined, 1], ['smsSent', 100]]);
  });
  it('applies a discount to the package price (not to usage) and tax to what is left; units with no price are not billed', () => {
    const i = buildPlanInvoice(sub({ discountPercent: '10.00', taxPercent: '18.00' }), '2027-01', { smsSent: 1100, contacts: 99999, teamMembers: 99 });
    expect(i.lines.map((l) => l.amountMinor)).toEqual([5_000_000, -500_000, 2000]);
    expect(i.subtotalMinor).toBe(4_502_000);
    expect(i.taxMinor).toBe(Math.round(4_502_000 * 0.18));
  });
  it('windows: a month for monthly packages, the whole campaign for per-campaign', () => {
    expect(usageWindow({ billing: 'monthly', startedOn: '2027-01-10' }, new Date('2027-02-14T10:00:00Z'))).toEqual({ from: '2027-02-01', to: '2027-03-01' });
    expect(usageWindow({ billing: 'monthly', startedOn: '2027-01-10' }, new Date('2027-12-31T10:00:00Z'))).toEqual({ from: '2027-12-01', to: '2028-01-01' });
    expect(usageWindow({ billing: 'per_campaign', startedOn: '2027-01-10' }, new Date('2027-02-14T10:00:00Z'))).toEqual({ from: '2027-01-10', to: null });
  });
});

run('Packages, metering and invoicing (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  let clock = new Date('2027-01-20T10:00:00Z');
  const tok: Record<string, string> = {};
  const as = (k: string) => ({ Authorization: `Bearer ${tok[k]}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  let tenant = '', legacy = '', caTenant = '';

  async function login(a: typeof app, phone: string) {
    const r = await ensureUser(a, phone);
    return (await tokenFor(a, phone)).body.accessToken as string;
  }
  const plan = {
    name: 'Assembly package', region: 'IN', billing: 'per_campaign', priceMinor: 5_000_000,
    included: { smsSent: 1000, callMinutes: 500 }, overageMinor: { smsSent: 20, callMinutes: 300 }, hardLimits: { callMinutes: 600, teamMembers: 3, contacts: 5 }, active: true,
  };
  async function addUsage(kind: 'sms' | 'voice', n: number, at: string, secEach = 240) {
    const rows = Array.from({ length: n }, () => `('${tenant}', '${kind}', 'outbound', 'completed', '${at}', ${kind === 'voice' ? secEach : 'NULL'})`).join(',');
    await owner.query(`INSERT INTO interactions (tenant_id, channel, direction, status, started_at, duration_sec) VALUES ${rows}`);
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, invoices, subscriptions, plans, interactions, contacts, memberships, tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env: testEnv(), pool, now: () => clock });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await login(app, '+919800001101');
    tok.wes = await login(app, '+919800001101'); // made platform staff below
    await owner.query("UPDATE users SET is_wes_admin = true");
    tok.wes = await login(app, '+919800001101');
    tok.cand = await login(app, '+919800001102');
    tok.other = await login(app, '+919800001103');
    tenant = (await request(app).post('/api/tenants').set(as('cand')).send({ raceType: 'assembly', seatCode: 'PL-1', electionDate: '2027-02-20', campaignName: 'Plan Test' })).body.id;
    legacy = (await request(app).post('/api/tenants').set(as('other')).send({ raceType: 'assembly', seatCode: 'PL-2', electionDate: '2027-02-20', campaignName: 'No Plan' })).body.id;
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('only platform staff define packages, and a package must make sense', async () => {
    await request(app).put('/api/admin/plans/assembly-2027').set(as('cand')).send(plan).expect(403);
    await request(app).put('/api/admin/plans/assembly-2027').set(as('wes')).send({ ...plan, overageMinor: { contacts: 5 } }).expect(400); // contacts are capped, not priced
    await request(app).put('/api/admin/plans/assembly-2027').set(as('wes')).send({ ...plan, hardLimits: { callMinutes: 100 } }).expect(400); // cap below what is included
    await request(app).put('/api/admin/plans/assembly-2027').set(as('wes')).send({ ...plan, extra: 1 }).expect(400);
    const p = (await request(app).put('/api/admin/plans/assembly-2027').set(as('wes')).send(plan).expect(200)).body;
    expect(p).toMatchObject({ code: 'assembly-2027', currency: 'INR', priceMinor: 5_000_000 });
    expect((await request(app).get('/api/admin/plans').set(as('wes')).expect(200)).body).toHaveLength(1);
  });

  it('assigns a package to a campaign of the same region, copying its terms', async () => {
    await request(app).put('/api/admin/plans/ca-municipal').set(as('wes')).send({ ...plan, name: 'Municipal', region: 'CA', priceMinor: 300_000, hardLimits: {} }).expect(200);
    await request(app).put(`/api/admin/tenants/${tenant}/plan`).set(as('wes')).send({ planCode: 'ca-municipal', startedOn: '2027-01-10' }).expect(422);
    await request(app).put(`/api/admin/tenants/${tenant}/plan`).set(as('wes')).send({ planCode: 'nope', startedOn: '2027-01-10' }).expect(404);
    await request(app).put(`/api/admin/tenants/${tenant}/plan`).set(as('cand')).send({ planCode: 'assembly-2027', startedOn: '2027-01-10' }).expect(403);
    await request(app).put(`/api/admin/tenants/${tenant}/plan`).set(as('wes')).send({ planCode: 'assembly-2027', startedOn: '2027-01-10', discountPercent: 10 }).expect(200);
    // Changing the package afterwards does not change the deal already made.
    await request(app).put('/api/admin/plans/assembly-2027').set(as('wes')).send({ ...plan, priceMinor: 9_999_999, included: { smsSent: 1 } }).expect(200);
    const [s] = await q('SELECT * FROM subscriptions WHERE tenant_id = $1', [tenant]);
    expect(Number(s.price_minor)).toBe(5_000_000);
    expect(s.terms.included.smsSent).toBe(1000);
    await request(app).put('/api/admin/plans/assembly-2027').set(as('wes')).send(plan).expect(200);
  });

  it("the owner sees the package and how much is used; others cannot", async () => {
    await addUsage('sms', 1200, '2027-01-15T06:00:00Z');
    await addUsage('voice', 100, '2027-01-16T06:00:00Z'); // 100 calls x 4 minutes
    const b = (await request(app).get(`/api/t/${tenant}/billing`).set(as('cand')).expect(200)).body;
    expect(b.subscription).toMatchObject({ plan: 'Assembly package', billing: 'per_campaign' });
    const m = Object.fromEntries(b.usage.metrics.map((x: any) => [x.metric, x]));
    expect(m.smsSent).toMatchObject({ used: 1200, included: 1000, over: true, atLimit: false });
    expect(m.callMinutes).toMatchObject({ used: 400, included: 500, over: false, limit: 600 });
    expect(m.teamMembers).toMatchObject({ used: 1, limit: 3 });
    await request(app).get(`/api/t/${tenant}/billing`).set(as('other')).expect(404);
    // A campaign with no package just has none.
    expect((await request(app).get(`/api/t/${legacy}/billing`).set(as('other')).expect(200)).body.usage).toBeNull();
  });

  it('a capped package stops the action, with a plain message', async () => {
    // team: owner + 2 more is the cap of 3
    await request(app).post(`/api/t/${tenant}/members`).set(as('cand')).send({ email: emailFor('+919800001201'), role: 'coordinator' }).expect(201);
    await request(app).post(`/api/t/${tenant}/members`).set(as('cand')).send({ email: emailFor('+919800001202'), role: 'coordinator' }).expect(201);
    const r = await request(app).post(`/api/t/${tenant}/members`).set(as('cand')).send({ email: emailFor('+919800001203'), role: 'coordinator' }).expect(402);
    expect(r.body.error).toBe('PLAN_LIMIT_REACHED');
    expect(r.body.message).toContain('3 team members');
    // contacts: cap of 5
    for (let i = 0; i < 5; i++) await request(app).post(`/api/t/${tenant}/contacts`).set(as('cand')).send({ phone: `+91981110010${i}`, source: 'form' }).expect(201);
    expect((await request(app).post(`/api/t/${tenant}/contacts`).set(as('cand')).send({ phone: '+919811100199', source: 'form' }).expect(402)).body.error).toBe('PLAN_LIMIT_REACHED');
    // a campaign with no package is never capped
    for (let i = 0; i < 7; i++) await request(app).post(`/api/t/${legacy}/contacts`).set(as('other')).send({ phone: `+91981120010${i}`, source: 'form' }).expect(201);
  });

  it('call minutes at the cap are detected, so a running campaign pauses instead of overspending', async () => {
    const t = (await q('SELECT * FROM tenants WHERE id = $1', [tenant]))[0];
    const tenantRow = { id: tenant, timeZone: t.time_zone } as any;
    expect(await withTenant(pool, tenant, (db) => planLimitReached(db, tenantRow, 'callMinutes', clock))).toBeNull(); // 400 of 600
    await addUsage('voice', 50, '2027-01-18T06:00:00Z'); // +200 minutes = 600
    expect(await withTenant(pool, tenant, (db) => planLimitReached(db, tenantRow, 'callMinutes', clock))).toBeNull(); // at the cap, not over it
    expect(await withTenant(pool, tenant, (db) => planLimitReached(db, tenantRow, 'callMinutes', clock, 1))).toEqual({ limit: 600, used: 600 });
    await addUsage('voice', 1, '2027-01-19T06:00:00Z', 60);
    expect(await withTenant(pool, tenant, (db) => planLimitReached(db, tenantRow, 'callMinutes', clock))).toEqual({ limit: 600, used: 601 });
  });

  it('invoices the package once, then only new usage beyond what is included', async () => {
    const jan = (await request(app).post('/api/admin/invoices/generate').set(as('wes')).send({ month: '2027-01' }).expect(201)).body;
    const mine = jan.created.find((c: any) => c.tenantId === tenant);
    expect(mine).toMatchObject({ currency: 'INR' });
    const [i1] = await q("SELECT * FROM invoices WHERE tenant_id = $1 AND period_start = '2027-01-01'", [tenant]);
    expect(i1.lines.map((l: any) => [l.metric ?? 'package', l.quantity, Number(l.amountMinor)])).toEqual([
      ['package', 1, 5_000_000], ['package', 1, -500_000], ['smsSent', 200, 4000], ['callMinutes', 101, 30_300],
    ]);
    expect(Number(i1.total_minor)).toBe(5_000_000 - 500_000 + 4000 + 30_300);
    // The same month again changes nothing.
    expect((await request(app).post('/api/admin/invoices/generate').set(as('wes')).send({ month: '2027-01' }).expect(201)).body.created).toEqual([]);
    // February: more texts, no package fee again, and only the new texts are billed.
    await addUsage('sms', 300, '2027-02-05T06:00:00Z');
    await request(app).post('/api/admin/invoices/generate').set(as('wes')).send({ month: '2027-02' }).expect(201);
    const [i2] = await q("SELECT * FROM invoices WHERE tenant_id = $1 AND period_start = '2027-02-01'", [tenant]);
    expect(i2.lines.map((l: any) => [l.metric, l.quantity])).toEqual([['smsSent', 300]]);
    // The owner sees both invoices.
    expect((await request(app).get(`/api/t/${tenant}/billing`).set(as('cand')).expect(200)).body.invoices).toHaveLength(2);
  });

  it('the old service-office subscriptions still bill as before', async () => {
    await request(app).put(`/api/admin/tenants/${legacy}/subscription`).set(as('wes')).send({ plan: 'Office monthly', priceMinor: 100_000, smsRateMinor: 50, smsIncluded: 10, startedOn: '2027-01-01' }).expect(200);
    await request(app).post('/api/admin/invoices/generate').set(as('wes')).send({ month: '2027-03' }).expect(201);
    const [inv] = await q("SELECT * FROM invoices WHERE tenant_id = $1", [legacy]);
    expect(Number(inv.total_minor)).toBe(100_000);
  });
});
