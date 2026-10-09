/** Phase 3, Tool 8: constituent service: tickets, assignment, status texts, reports, billing, retention. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createApp, resolveDeps } from '../src/app.js';
import { purgeDueTenants } from '../src/modules/privacy/purge.js';
import { buildInvoice } from '../src/modules/service/admin.js';
import { guessCategory } from '../src/modules/service/categories.js';
import { dueDate } from '../src/modules/service/tickets.js';
import { testEnv } from './env.js';
import { ensureUser, tokenFor, emailFor } from './auth-helper.js';

describe('categories and dates', () => {
  it('guesses a category from English, Hinglish, Punjabi and Hindi words', () => {
    expect(guessCategory('no water since 3 days')).toBe('water');
    expect(guessCategory('gali me pani nahi aa raha')).toBe('water');
    expect(guessCategory('ਸੜਕ ਵਿੱਚ ਟੋਇਆ ਹੈ')).toBe('roads');
    expect(guessCategory('बिजली का खंभा गिरा')).toBe('electricity');
    expect(guessCategory('Streetlight light not working')).toBe('electricity');
    expect(guessCategory('pension not received')).toBe('welfare');
    expect(guessCategory('Sanitation')).toBe('sanitation'); // the category name itself works
    expect(guessCategory('hello there')).toBeNull();
    expect(guessCategory('waterfall tickets')).toBeNull(); // whole words only
  });

  it('due dates follow the service level, shorter for urgent and high priority', () => {
    const from = new Date('2027-03-10T00:00:00Z');
    expect(dueDate(from, 7, 'normal').toISOString()).toBe('2027-03-17T00:00:00.000Z');
    expect(dueDate(from, 7, 'high').toISOString()).toBe('2027-03-14T00:00:00.000Z');
    expect(dueDate(from, 7, 'urgent').toISOString()).toBe('2027-03-13T00:00:00.000Z');
    expect(dueDate(from, 1, 'urgent').toISOString()).toBe('2027-03-11T00:00:00.000Z');
  });
});

describe('invoice maths', () => {
  const sub = { plan: 'Office', price_minor: '300000', sms_rate_minor: '50', sms_included: 100, tax_percent: null, started_on: '2027-01-01' };
  it('monthly price plus resident texts beyond the included amount', () => {
    const i = buildInvoice(sub, '2027-03', 340);
    expect(i.lines).toHaveLength(2);
    expect(i.lines[1]).toMatchObject({ quantity: 240, unitMinor: 50, amountMinor: 12000 });
    expect(i).toMatchObject({ subtotalMinor: 312000, taxMinor: 0, totalMinor: 312000 });
    expect(buildInvoice(sub, '2027-03', 80).lines).toHaveLength(1);
  });
  it('first month is pro rata; tax only when a rate is set', () => {
    const i = buildInvoice({ ...sub, started_on: '2027-03-16', tax_percent: '18.00' }, '2027-03', 0);
    expect(i.lines[0]!.amountMinor).toBe(Math.round((300000 * 16) / 31)); // 16 of 31 days
    expect(i.taxMinor).toBe(Math.round(i.subtotalMinor * 0.18));
    expect(i.totalMinor).toBe(i.subtotalMinor + i.taxMinor);
    expect(buildInvoice({ ...sub, started_on: '2027-04-01' }, '2027-03', 0).lines).toHaveLength(0); // not started yet
  });
});

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('constituent service (integration)', () => {
  const env = testEnv();
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>, deps: ReturnType<typeof resolveDeps>;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  let tenant = '', rootArea = '', areaA = '', areaB = '', otherTenant = '';
  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const svc = (path: string) => `/api/t/${tenant}/service${path}`;
  async function login(phone: string) {
    const r = await ensureUser(app, phone);
    return (await tokenFor(app, phone)).body.accessToken as string;
  }
  const waitFor = async (check: () => Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  const newTicket = (who: string, body: object) => request(app).post(svc('/tickets')).set(as(who)).send({ title: 'Test request', ...body });

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE tenants, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    deps = resolveDeps({ env, pool });
    app = createApp(deps);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tok.owner = await login('+919800002001');
    tenant = (await request(app).post('/api/tenants').set(as('owner')).send({ kind: 'office', raceType: 'assembly', seatCode: 'SV-1', electionDate: '2027-02-20', campaignName: 'Office of MLA Test' })).body.id;
    await owner.query('UPDATE tenants SET is_demo = true WHERE id = $1', [tenant]); // simulated texts: nobody is messaged
    await request(app).patch(`/api/tenants/${tenant}/settings`).set(as('owner')).send({ slug: 'mla-test', candidateName: 'MLA Test' }).expect(200);
    otherTenant = (await request(app).post('/api/tenants').set(as('owner')).send({ raceType: 'assembly', seatCode: 'SV-2', electionDate: '2027-02-20', campaignName: 'Other' })).body.id;

    rootArea = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ level: 'constituency', nameEn: 'Test Constituency' })).body.id;
    areaA = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ parentId: rootArea, level: 'locality', nameEn: 'Model Town', code: 'MT12', namePa: 'ਮਾਡਲ ਟਾਊਨ' })).body.id;
    areaB = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ parentId: rootArea, level: 'locality', nameEn: 'Dugri', code: 'DG3' })).body.id;
    for (const [who, phone, role] of [['staff1', '+919800002002', 'service_staff'], ['staff2', '+919800002003', 'service_staff'], ['worker', '+919800002004', 'field_worker']] as const) {
      await request(app).post(`/api/t/${tenant}/members`).set(as('owner')).send({ email: emailFor(phone), phone, name: who, role }).expect(201);
      tok[who] = await login(phone);
      id[who] = (jwt.decode(tok[who]!) as { sub: string }).sub;
    }
    await request(app).put(svc('/routes')).set(as('owner')).send({ areaId: areaA, userId: id.staff1 }).expect(200);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  describe('who can do what', () => {
    it('only owner, manager and service staff use the service module', async () => {
      await request(app).get(svc('/tickets')).set(as('worker')).expect(403);
      await request(app).get(svc('/tickets')).expect(401);
      await request(app).get(svc('/tickets')).set(as('staff1')).expect(200);
      const cats = (await request(app).get(svc('/categories')).set(as('staff1')).expect(200)).body;
      expect(cats.find((c: { key: string }) => c.key === 'water')).toMatchObject({ en: 'Water', pa: 'ਪਾਣੀ', hi: 'पानी' });
    });

    it('routes can be set by the owner (not service staff) and only to service staff', async () => {
      await request(app).put(svc('/routes')).set(as('staff1')).send({ areaId: areaB, userId: id.staff1 }).expect(403);
      await request(app).put(svc('/routes')).set(as('owner')).send({ areaId: areaB, userId: id.worker }).expect(422);
      const routes = (await request(app).get(svc('/routes')).set(as('owner')).expect(200)).body;
      expect(routes).toEqual([{ areaId: areaA, area: 'Model Town', level: 'locality', userId: id.staff1, user: 'staff1' }]);
    });
  });

  describe('taking a request', () => {
    let t1 = '', t2 = '', t3 = '';

    it('an office request gets the next number, a guessed category, the area\'s team member and a due date', async () => {
      const r = await newTicket('owner', { title: 'No water since three days', areaCode: 'MT12', name: 'Gurdeep', phone: '+919811200001', smsConsent: true }).expect(201);
      t1 = r.body.id;
      expect(r.body).toMatchObject({ ref: 'T-0001', status: 'assigned', assignedTo: id.staff1 });
      const row = (await q('SELECT category, geo_area_id, due_at, created_at, channel FROM tickets WHERE id = $1', [t1]))[0];
      expect(row).toMatchObject({ category: 'water', geo_area_id: areaA, channel: 'office' });
      expect(Math.round((new Date(row.due_at).getTime() - new Date(row.created_at).getTime()) / 86_400_000)).toBe(7);
    });

    it('a request from a place with no team member stays unassigned; a child area inherits its parent\'s team member', async () => {
      const child = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ parentId: areaA, level: 'locality', nameEn: 'Block C', code: 'MT12C' })).body.id;
      const inherits = await newTicket('owner', { title: 'Streetlight broken', areaId: child }).expect(201);
      expect(inherits.body.assignedTo).toBe(id.staff1);
      const none = await newTicket('owner', { title: 'Pension not received', areaCode: 'DG3', priority: 'urgent' }).expect(201);
      t2 = none.body.id;
      expect(none.body).toMatchObject({ status: 'new', assignedTo: null });
      expect((await q('SELECT category, priority FROM tickets WHERE id = $1', [t2]))[0]).toMatchObject({ category: 'welfare', priority: 'urgent' });
      t3 = inherits.body.id;
    });

    it('rejects unknown fields, a missing phone for texts, and short titles', async () => {
      await newTicket('owner', { caste: 'x' }).expect(400);
      await newTicket('owner', { smsConsent: true }).expect(422);
      await newTicket('owner', { title: 'ab' }).expect(400);
    });

    it('texts the resident the acknowledgement within seconds (simulated), records consent, and notes it on the timeline', async () => {
      expect(await waitFor(async () => (await q('SELECT acknowledged_at FROM tickets WHERE id = $1', [t1]))[0].acknowledged_at !== null)).toBe(true);
      const [c] = await q("SELECT purpose, channel, captured_via FROM consents WHERE purpose = 'service'");
      expect(c).toMatchObject({ channel: 'sms', captured_via: 'form' });
      const ev = await q("SELECT kind, meta FROM ticket_events WHERE ticket_id = $1 AND kind = 'ack_sent'", [t1]);
      expect(ev).toHaveLength(1);
      expect(ev[0].meta.seconds).toBeLessThanOrEqual(5);
      expect(await q("SELECT 1 FROM interactions WHERE channel = 'sms' AND direction = 'outbound' AND status = 'completed'")).toHaveLength(1);
    });

    it('someone who asked not to be contacted gets no text and the office is told', async () => {
      await owner.query("UPDATE contacts SET opted_out = true WHERE tags @> ARRAY['service']");
      const r = await newTicket('owner', { title: 'Garbage not collected', name: 'Same person', phone: '+919811200001', smsConsent: true }).expect(201);
      expect(r.body.noTexts).toMatch(/no texts will be sent/);
      expect((await q('SELECT contact_id FROM tickets WHERE id = $1', [r.body.id]))[0].contact_id).toBeNull();
      await owner.query("UPDATE contacts SET opted_out = false WHERE tags @> ARRAY['service']");
      await owner.query('DELETE FROM suppressions');
    });

    it('twenty requests at the same moment get twenty different numbers', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => newTicket('owner', { title: `Parallel request ${i}` })));
      const refs = results.map((r) => r.body.ref as string);
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(refs).size).toBe(20);
    });

    it('lists and filters', async () => {
      const all = (await request(app).get(svc('/tickets?limit=100')).set(as('owner')).expect(200)).body;
      expect(all.total).toBeGreaterThanOrEqual(24);
      expect(all.items[0].phone === null || /\*{5}/.test(all.items[0].phone)).toBe(true);
      const mine = (await request(app).get(svc('/tickets?assigned=me')).set(as('staff1')).expect(200)).body;
      expect(mine.items.every((x: { assignedTo: string }) => x.assignedTo === id.staff1)).toBe(true);
      const water = (await request(app).get(svc('/tickets?category=water')).set(as('owner')).expect(200)).body;
      expect(water.items.map((x: { ref: string }) => x.ref)).toContain('T-0001');
      const found = (await request(app).get(svc('/tickets?q=pension')).set(as('owner')).expect(200)).body;
      expect(found.items).toHaveLength(1);
      expect((await request(app).get(svc('/tickets?q=%25')).set(as('owner')).expect(200)).body.total).toBe(0); // % is text, not a wildcard
      await request(app).get(svc('/tickets?status=nonsense')).set(as('owner')).expect(400);
    });

    describe('moving a request along', () => {
      const patch = (who: string, tid: string, body: object) => request(app).patch(svc(`/tickets/${tid}`)).set(as(who)).send(body);

      it('follows the allowed steps and asks for a note when resolving or rejecting', async () => {
        expect((await patch('staff1', t1, { status: 'closed' }).expect(409)).body.error).toBe('INVALID_TRANSITION');
        await patch('staff1', t1, { status: 'in_progress' }).expect(200);
        expect((await patch('staff1', t1, { status: 'resolved' }).expect(422)).body.error).toBe('NOTE_REQUIRED');
        const done = (await patch('staff1', t1, { status: 'resolved', resolutionNote: 'Tubewell motor replaced' }).expect(200)).body;
        expect(done).toMatchObject({ status: 'resolved', resolutionNote: 'Tubewell motor replaced' });
        expect(done.resolvedAt).toBeTruthy();
        expect(done.firstResponseAt).toBeTruthy();
        await patch('staff1', t1, { status: 'closed' }).expect(200);
        expect((await patch('staff1', t1, { status: 'in_progress' }).expect(409)).body.error).toBe('INVALID_TRANSITION'); // closed is final
      });

      it('texts the resident once per status, and never twice for the same one', async () => {
        expect(await waitFor(async () => (await q("SELECT count(*)::int AS n FROM ticket_events WHERE ticket_id = $1 AND kind = 'update_sent'", [t1]))[0].n >= 2)).toBe(true);
        const sent = (await q("SELECT meta->>'status' AS s FROM ticket_events WHERE ticket_id = $1 AND kind = 'update_sent' ORDER BY id", [t1])).map((x) => x.s);
        expect(sent).toEqual(['in_progress', 'resolved']);
      });

      it('reopening a resolved request clears the resolved time', async () => {
        const t = (await newTicket('owner', { title: 'Road repair needed', areaCode: 'MT12' }).expect(201)).body.id;
        await patch('staff1', t, { status: 'resolved', resolutionNote: 'Patched the road' }).expect(200);
        const re = (await patch('staff1', t, { status: 'in_progress' }).expect(200)).body;
        expect(re).toMatchObject({ status: 'in_progress', resolvedAt: null });
      });

      it('service staff work on their own requests and unassigned ones, not on a colleague\'s, and cannot reassign', async () => {
        expect((await patch('staff2', t3, { status: 'in_progress' }).expect(403)).body.error).toBe('NOT_YOUR_TICKET');
        await patch('staff2', t2, { assignedTo: id.staff2 }).expect(200); // takes an unassigned request
        expect((await q('SELECT status, assigned_to FROM tickets WHERE id = $1', [t2]))[0]).toMatchObject({ status: 'assigned', assigned_to: id.staff2 });
        expect((await patch('staff2', t2, { assignedTo: id.staff1 }).expect(403)).body.error).toBe('FORBIDDEN');
        await patch('owner', t2, { assignedTo: id.staff1 }).expect(200);
        await patch('owner', t2, { assignedTo: id.worker }).expect(422);
        await patch('owner', t2, { priority: 'low', category: 'welfare' }).expect(200);
        await patch('owner', t2, { bogus: 1 }).expect(400);
      });

      it('a note can be internal or visible to the resident; either counts as the first response', async () => {
        const t = (await newTicket('owner', { title: 'Drain blocked near school', name: 'Asha', phone: '+919811200002', smsConsent: true, areaCode: 'MT12' }).expect(201)).body.id;
        await request(app).post(svc(`/tickets/${t}/notes`)).set(as('staff1')).send({ body: 'Called the contractor', visibility: 'internal' }).expect(201);
        await request(app).post(svc(`/tickets/${t}/notes`)).set(as('staff1')).send({ body: 'A team will visit on Monday', visibility: 'public' }).expect(201);
        const detail = (await request(app).get(svc(`/tickets/${t}`)).set(as('staff1')).expect(200)).body;
        expect(detail.firstResponseAt).toBeTruthy();
        expect(detail.events.filter((e: { kind: string }) => e.kind === 'note').map((e: { visibility: string }) => e.visibility)).toEqual(['internal', 'public']);
        // The resident's page only shows public lines, and only with the right last 4 digits.
        const pub = (await request(app).get(`/api/public/mla-test/tickets/${detail.ref}?last4=0002`).expect(200)).body;
        expect(JSON.stringify(pub)).toContain('A team will visit on Monday');
        expect(JSON.stringify(pub)).not.toContain('contractor');
        await request(app).get(`/api/public/mla-test/tickets/${detail.ref}?last4=9999`).expect(404);
        await request(app).get(`/api/public/mla-test/tickets/${detail.ref}`).expect(404);
      });
    });
  });

  describe('reports and the "work done" export', () => {
    it('monthly figures by category, area and channel, with the acknowledgement speed', async () => {
      const month = new Date().toISOString().slice(0, 7);
      await waitFor(async () => (await q('SELECT count(acknowledged_at)::int AS n FROM tickets'))[0].n >= 2);
      const r = (await request(app).get(svc(`/reports?month=${month}`)).set(as('owner')).expect(200)).body;
      expect(r.received).toBeGreaterThanOrEqual(24);
      expect(r.resolved).toBeGreaterThanOrEqual(1);
      expect(r.serviceLevelDays).toBe(7);
      expect(r.byCategory.find((c: { category: string }) => c.category === 'water')).toMatchObject({ received: 1, resolved: 1 });
      expect(r.byArea.some((a: { area: string; received: number }) => a.area === 'Model Town' && a.received >= 3)).toBe(true);
      expect(r.byChannel).toEqual([{ channel: 'office', received: r.received }]);
      expect(r.acknowledgement.acknowledged).toBeGreaterThanOrEqual(2);
      expect(r.acknowledgement.within60s).toBe(r.acknowledgement.acknowledged);
      expect(r.trend).toHaveLength(6);
      expect(r.trend.at(-1).month).toBe(month);
      await request(app).get(svc('/reports?month=2027-13')).set(as('owner')).expect(400);
    });

    it('the export has no names, phone numbers or request text, and notes only for the owner on request', async () => {
      const from = '2020-01-01', to = '2099-01-01';
      const csv = (await request(app).get(svc(`/reports/work-done.csv?from=${from}&to=${to}`)).set(as('owner')).expect(200)).text;
      expect(csv).toContain('T-0001,water,Model Town');
      for (const secret of ['Gurdeep', '9811200001', 'No water since', 'Tubewell']) expect(csv).not.toContain(secret);
      const withNotes = (await request(app).get(svc(`/reports/work-done.csv?from=${from}&to=${to}&includeNotes=1`)).set(as('owner')).expect(200)).text;
      expect(withNotes).toContain('Tubewell motor replaced');
      await request(app).get(svc(`/reports/work-done.csv?from=${from}&to=${to}`)).set(as('staff1')).expect(403);
      await owner.query("UPDATE tickets SET resolution_note = '=HYPERLINK(\"x\")' WHERE ref = 'T-0001'");
      expect((await request(app).get(svc(`/reports/work-done.csv?from=${from}&to=${to}&includeNotes=1`)).set(as('owner'))).text).not.toMatch(/,=HYPERLINK/); // spreadsheet formulas are neutralised
    });
  });

  describe('billing', () => {
    it('only platform staff set subscriptions and run invoicing; the owner sees their own', async () => {
      const sub = { plan: 'Office service', priceMinor: 300000, smsRateMinor: 50, smsIncluded: 1, startedOn: '2020-01-01' };
      await request(app).put(`/api/admin/tenants/${tenant}/subscription`).set(as('owner')).send(sub).expect(403);
      await owner.query('UPDATE users SET is_wes_admin = true WHERE id = $1', [(jwt.decode(tok.owner!) as { sub: string }).sub]);
      tok.wes = await login('+919800002001');
      await request(app).put(`/api/admin/tenants/${tenant}/subscription`).set(as('wes')).send({ ...sub, extra: 1 }).expect(400);
      await request(app).put(`/api/admin/tenants/${tenant}/subscription`).set(as('wes')).send(sub).expect(200);
      const month = new Date().toISOString().slice(0, 7);
      const run = (await request(app).post('/api/admin/invoices/generate').set(as('wes')).send({ month }).expect(201)).body;
      expect(run.created).toHaveLength(1);
      expect(run.created[0]).toMatchObject({ tenantId: tenant, currency: 'INR' });
      expect(run.created[0].totalMinor).toBeGreaterThanOrEqual(300000);
      const again = (await request(app).post('/api/admin/invoices/generate').set(as('wes')).send({ month }).expect(201)).body;
      expect(again.created).toHaveLength(0);
      expect(again.skipped.some((s: { reason: string }) => s.reason === 'already invoiced')).toBe(true);

      const mine = (await request(app).get(svc('/billing')).set(as('owner')).expect(200)).body;
      expect(mine.subscription.plan).toBe('Office service');
      expect(mine.invoices).toHaveLength(1);
      await request(app).get(svc('/billing')).set(as('staff1')).expect(403);
      const invoiceId = mine.invoices[0].id;
      await request(app).post(`/api/admin/invoices/${tenant}/${invoiceId}/paid`).set(as('wes')).expect(200);
      expect((await request(app).post(`/api/admin/invoices/${tenant}/${invoiceId}/void`).set(as('wes')).expect(409)).body.error).toBe('ALREADY_SETTLED');
      expect((await request(app).get(`/api/admin/invoices?month=${month}`).set(as('wes')).expect(200)).body[0]).toMatchObject({ status: 'paid', campaign: 'Office of MLA Test' });
    });

    it('a cancelled subscription is not invoiced', async () => {
      await request(app).put(`/api/admin/tenants/${tenant}/subscription`).set(as('wes')).send({ plan: 'Office service', priceMinor: 300000, startedOn: '2020-01-01', status: 'cancelled' }).expect(200);
      const run = (await request(app).post('/api/admin/invoices/generate').set(as('wes')).send({ month: '2027-06' }).expect(201)).body;
      expect(run.created).toHaveLength(0);
      expect(run.skipped[0].reason).toMatch(/cancelled/);
    });
  });

  describe('retention: personal details are removed, the figures stay', () => {
    it('an office with ticket retention scrubs old closed requests and the residents who only appear in them', async () => {
      await request(app).patch(`/api/tenants/${tenant}/settings`).set(as('owner')).send({ ticketRetentionDays: 10 }).expect(400); // minimum is 30
      await request(app).patch(`/api/tenants/${tenant}/settings`).set(as('owner')).send({ ticketRetentionDays: 30 }).expect(200);
      const [old] = await q("SELECT id, contact_id FROM tickets WHERE ref = 'T-0001'");
      expect(old.contact_id).toBeTruthy();
      await request(app).post(svc(`/tickets/${old.id}/notes`)).set(as('owner')).send({ body: 'Spoke to Gurdeep at his house' }).expect(201);
      await owner.query("UPDATE tickets SET closed_at = now() - interval '40 days', resolved_at = now() - interval '45 days' WHERE id = $1", [old.id]);
      // Not old enough, and not closed: both must stay as they are.
      const recent = (await newTicket('owner', { title: 'Recent request' }).expect(201)).body.id;
      await request(app).patch(svc(`/tickets/${recent}`)).set(as('owner')).send({ status: 'resolved', resolutionNote: 'Done just now' }).expect(200);

      const results = await purgeDueTenants(deps);
      expect(results.find((r) => r.tenantId === tenant)?.counts).toMatchObject({ tickets: 1 });

      const [t] = await q('SELECT title, description, requester_name, resolution_note, contact_id, scrubbed_at, category, geo_area_id, status, resolved_at FROM tickets WHERE id = $1', [old.id]);
      expect(t).toMatchObject({ title: '[removed]', description: null, requester_name: null, resolution_note: null, contact_id: null, category: 'water', geo_area_id: areaA, status: 'closed' });
      expect(t.scrubbed_at).toBeTruthy();
      expect(t.resolved_at).toBeTruthy();
      expect((await q("SELECT body FROM ticket_events WHERE ticket_id = $1 AND kind = 'note'", [old.id])).every((e) => e.body === null)).toBe(true);
      expect(await q('SELECT 1 FROM contacts WHERE id = $1', [old.contact_id])).toHaveLength(0); // only appeared in that request
      expect((await q('SELECT scrubbed_at FROM tickets WHERE id = $1', [recent]))[0].scrubbed_at).toBeNull();
      expect((await q("SELECT scrubbed_at FROM tickets WHERE ref = 'T-0002'"))[0].scrubbed_at).toBeNull(); // still open

      // The figures survive: the report for that month still counts the request by category and area.
      const month = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 7);
      const rep = (await request(app).get(svc(`/reports?month=${month}`)).set(as('owner')).expect(200)).body;
      expect(rep.byCategory.find((c: { category: string }) => c.category === 'water')?.resolved).toBeGreaterThanOrEqual(1);

      // And it is final: no more changes, notes, or public lookups.
      expect((await request(app).patch(svc(`/tickets/${old.id}`)).set(as('owner')).send({ priority: 'high' }).expect(409)).body.error).toBe('TICKET_ARCHIVED');
      await request(app).post(svc(`/tickets/${old.id}/notes`)).set(as('owner')).send({ body: 'late note' }).expect(409);
      expect(await purgeDueTenants(deps)).toEqual([]); // nothing left to do
    }, 60_000);

    it('erasing a person scrubs their requests too', async () => {
      const [asha] = await q("SELECT t.id AS ticket_id, t.contact_id FROM tickets t WHERE t.requester_name = 'Asha'");
      expect(asha.contact_id).toBeTruthy();
      await request(app).delete(`/api/t/${tenant}/privacy/contacts/${asha.contact_id}`).set(as('owner')).expect(200);
      expect((await q('SELECT title, requester_name, contact_id, scrubbed_at FROM tickets WHERE id = $1', [asha.ticket_id]))[0]).toMatchObject({ title: '[removed]', requester_name: null, contact_id: null });
    });

    it('the campaign deletion after an election scrubs every request as well', async () => {
      const camp = otherTenant;
      await owner.query("UPDATE tenants SET is_demo = true WHERE id = $1", [camp]);
      const t = (await request(app).post(`/api/t/${camp}/service/tickets`).set(as('owner')).send({ title: 'A campaign request', name: 'Resident' }).expect(201)).body.id;
      await request(app).post(`/api/t/${camp}/privacy/purge`).set(as('owner')).send({ confirm: 'DELETE' }).expect(200);
      expect((await q('SELECT title, requester_name, scrubbed_at FROM tickets WHERE id = $1', [t]))[0]).toMatchObject({ title: '[removed]', requester_name: null });
    });
  });
});
