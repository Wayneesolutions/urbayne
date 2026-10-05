/** Phase 2 integration: team, field visits (offline sync), events and permissions, shift reminders, finance, signs. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { testEnv } from './env.js';

const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
const run = OWNER_URL && APP_URL ? describe : describe.skip;
const env: Env = testEnv();

run('Phase 2 (integration)', () => {
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const tok: Record<string, string> = {};
  let tin = '', tca = '', area = '', area2 = '', turf = '', contactA = '';
  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  async function login(phone: string) {
    const r = await request(app).post('/api/auth/otp/request').send({ phone }).expect(200);
    return (await request(app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode }).expect(200)).body.accessToken as string;
  }

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE audit_log, finance_signoffs, finance_entries, rate_list, signs, shift_assignments, shifts, events, door_visits, turfs, assistant_questions, share_links, survey_responses, interactions, campaign_runs, consents, contacts, content_items, geo_areas, memberships, tenants, otp_codes, users CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    app = createApp({ env, pool });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tok.owner = await login('+919800000201');
    tin = (await request(app).post('/api/tenants').set(as('owner')).send({ raceType: 'assembly', seatCode: 'P2', electionDate: '2027-02-20', campaignName: 'P2 Candidate' }).expect(201)).body.id;
    await owner.query('UPDATE tenants SET is_demo = true, spend_limit_minor = 400000000 WHERE id = $1', [tin]);
    const root = (await request(app).post(`/api/t/${tin}/geo`).set(as('owner')).send({ level: 'constituency', nameEn: 'Root' }).expect(201)).body.id;
    area = (await request(app).post(`/api/t/${tin}/geo`).set(as('owner')).send({ parentId: root, level: 'locality', nameEn: 'Area A' }).expect(201)).body.id;
    area2 = (await request(app).post(`/api/t/${tin}/geo`).set(as('owner')).send({ parentId: root, level: 'locality', nameEn: 'Area B' }).expect(201)).body.id;
    contactA = (await request(app).post(`/api/t/${tin}/contacts`).set(as('owner')).send({ phone: '+919811100001', name: 'House 1', source: 'form', geoAreaId: area,
      consents: [{ purpose: 'reminder', channel: 'sms', textVersion: 'v1', locale: 'pa', capturedVia: 'form' }] }).expect(201)).body.id;
    await request(app).post(`/api/t/${tin}/contacts`).set(as('owner')).send({ phone: '+919811100002', name: 'House 2', source: 'form', geoAreaId: area }).expect(201);
    await request(app).post(`/api/t/${tin}/contacts`).set(as('owner')).send({ phone: '+919811100003', name: 'Other area', source: 'form', geoAreaId: area2 }).expect(201);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  it('team: owner adds a worker; a worker cannot add managers', async () => {
    await request(app).post(`/api/t/${tin}/members`).set(as('owner')).send({ phone: '+919800000202', name: 'Worker W', role: 'field_worker' }).expect(201);
    tok.worker = await login('+919800000202');
    await request(app).post(`/api/t/${tin}/members`).set(as('worker')).send({ phone: '+919800000203', role: 'manager' }).expect(403);
    const members = (await request(app).get(`/api/t/${tin}/members`).set(as('owner')).expect(200)).body;
    expect(members.map((m: { role: string }) => m.role).sort()).toEqual(['field_worker', 'owner']);
  });

  it('field: worker sees only their assigned area, with last 4 digits', async () => {
    const workerId = (await owner.query("SELECT id FROM users WHERE name = 'Worker W'")).rows[0].id;
    turf = (await request(app).post(`/api/t/${tin}/field/turfs`).set(as('owner')).send({ geoAreaId: area, name: 'Area A', assignedUserId: workerId }).expect(201)).body.id;
    await request(app).post(`/api/t/${tin}/field/turfs`).set(as('owner')).send({ geoAreaId: area2, name: 'Area B' }).expect(201);
    const mine = (await request(app).get(`/api/t/${tin}/field/my-turfs`).set(as('worker')).expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0].households.map((h: { name: string }) => h.name).sort()).toEqual(['House 1', 'House 2']);
    expect(mine[0].households[0].phoneEnd).toMatch(/^\d{4}$/);
    await request(app).get(`/api/t/${tin}/field/turfs`).set(as('worker')).expect(403);
  });

  it('field: offline batch sync is idempotent and rejects other turfs', async () => {
    const other = (await owner.query("SELECT id FROM turfs WHERE name = 'Area B'")).rows[0].id;
    const v1 = { clientUuid: randomUUID(), turfId: turf, contactId: contactA, result: 'supporter', visitedAt: new Date().toISOString() };
    const v2 = { clientUuid: randomUUID(), turfId: turf, household: 'New house near gurdwara', result: 'undecided', visitedAt: new Date().toISOString() };
    const bad = { clientUuid: randomUUID(), turfId: other, household: 'x', result: 'supporter', visitedAt: new Date().toISOString() };
    const r1 = (await request(app).post(`/api/t/${tin}/field/visits/batch`).set(as('worker')).send({ visits: [v1, v2, bad] }).expect(200)).body;
    expect(r1).toEqual({ accepted: 2, duplicates: 0, rejected: [bad.clientUuid] });
    const r2 = (await request(app).post(`/api/t/${tin}/field/visits/batch`).set(as('worker')).send({ visits: [v1, v2] }).expect(200)).body;
    expect(r2).toMatchObject({ accepted: 0, duplicates: 2 });
    const summary = (await request(app).get(`/api/t/${tin}/field/summary`).set(as('owner')).expect(200)).body;
    expect(summary).toEqual([{ area: 'Area A', counts: { supporter: 1, undecided: 1 } }]);
  });

  let eventId = '';
  it('events: India rallies need granted permission with a reference before confirming', async () => {
    eventId = (await request(app).post(`/api/t/${tin}/ops/events`).set(as('owner')).send({ kind: 'rally', title: 'Rally', geoAreaId: area, startsAt: '2027-02-01T11:00:00+05:30' }).expect(201)).body.id;
    await request(app).patch(`/api/t/${tin}/ops/events/${eventId}`).set(as('owner')).send({ permissionStatus: 'not_needed' }).expect(422);
    await request(app).patch(`/api/t/${tin}/ops/events/${eventId}`).set(as('owner')).send({ status: 'confirmed' }).expect(422);
    await request(app).patch(`/api/t/${tin}/ops/events/${eventId}`).set(as('owner')).send({ permissionStatus: 'granted' }).expect(422);
    await request(app).patch(`/api/t/${tin}/ops/events/${eventId}`).set(as('owner')).send({ permissionStatus: 'granted', permissionRef: 'SUV/LDH/123' }).expect(200);
    await request(app).patch(`/api/t/${tin}/ops/events/${eventId}`).set(as('owner')).send({ status: 'confirmed' }).expect(200);
  });

  it('events: finishing with a cost creates one expense entry, never two', async () => {
    await request(app).patch(`/api/t/${tin}/ops/events/${eventId}`).set(as('owner')).send({ status: 'done', costMinor: 12_500_00 }).expect(200);
    await request(app).patch(`/api/t/${tin}/ops/events/${eventId}`).set(as('owner')).send({ status: 'done', costMinor: 12_500_00 }).expect(200);
    const entries = (await request(app).get(`/api/t/${tin}/finance/entries`).set(as('owner')).expect(200)).body;
    expect(entries.filter((e: { source: string }) => e.source === 'event')).toHaveLength(1);
  });

  it('shifts: reminders only go to volunteers who agreed to texts (simulated in demo)', async () => {
    const shift = (await request(app).post(`/api/t/${tin}/ops/shifts`).set(as('owner')).send({ eventId, title: 'Chairs', startsAt: '2027-02-01T09:00:00+05:30', needed: 2 }).expect(201)).body.id;
    const other = (await owner.query("SELECT id FROM contacts WHERE name = 'House 2'")).rows[0].id;
    await request(app).post(`/api/t/${tin}/ops/shifts/${shift}/assign`).set(as('owner')).send({ contactIds: [contactA, other] }).expect(200);
    const r = (await request(app).post(`/api/t/${tin}/ops/shifts/${shift}/remind`).set(as('owner')).expect(200)).body;
    expect(r).toEqual({ sent: 1, skipped: 1, failed: 0, simulated: true });
  });

  it('finance: rate-list flag, limits, sign-off lock, export only after sign-off', async () => {
    const rl = (await request(app).post(`/api/t/${tin}/finance/rate-list`).set(as('owner')).send({ item: 'Chair (per day)', unit: 'chair', rateMinor: 1000 }).expect(201)).body.id;
    const e = (await request(app).post(`/api/t/${tin}/finance/entries`).set(as('owner')).send({
      kind: 'expense', entryDate: '2027-01-10', amountMinor: 50_000, category: 'Public meeting / rally', description: 'Chairs', partyName: 'Tent house', quantity: 100, unitRateMinor: 500, rateListId: rl,
    }).expect(201)).body;
    expect(e.flags.map((f: { code: string }) => f.code)).toEqual(['MISSING_BILL', 'BELOW_RATE_LIST']);
    await request(app).get(`/api/t/${tin}/finance/export.csv`).set(as('owner')).expect(409);
    await request(app).post(`/api/t/${tin}/finance/signoff`).set(as('owner')).send({ periodTo: '2027-01-31' }).expect(201);
    await request(app).post(`/api/t/${tin}/finance/entries`).set(as('owner')).send({
      kind: 'expense', entryDate: '2027-01-20', amountMinor: 100, category: 'Other', description: 'Late', partyName: 'X',
    }).expect(423);
    const csv = await request(app).get(`/api/t/${tin}/finance/export.csv?kind=expense`).set(as('owner')).expect(200);
    expect(csv.text).toContain('Tent house');
    expect(csv.text).toContain('BELOW_RATE_LIST');
    await request(app).get(`/api/t/${tin}/finance/summary`).set(as('worker')).expect(403);
  });

  it('Canada: contribution limits, receipts, and a planned sign route', async () => {
    const capp = createApp({ env: { ...env, DEPLOY_REGION: 'CA' }, pool });
    const r = await request(capp).post('/api/auth/otp/request').send({ phone: '+12045550301' });
    const token = (await request(capp).post('/api/auth/otp/verify').send({ phone: '+12045550301', code: r.body.devCode })).body.accessToken;
    const a = { Authorization: `Bearer ${token}` };
    tca = (await request(capp).post('/api/tenants').set(a).send({ raceType: 'ward', seatCode: 'W9', electionDate: '2026-10-28', campaignName: 'CA P2' }).expect(201)).body.id;
    await request(capp).patch(`/api/tenants/${tca}/settings`).set(a).send({ contributionLimitMinor: 75_000, officeLat: 49.95, officeLng: -97.2 }).expect(200);
    const c1 = (await request(capp).post(`/api/t/${tca}/finance/entries`).set(a).send({ kind: 'contribution', entryDate: '2026-10-01', amountMinor: 50_000, category: 'Individual', description: 'Donation', partyName: 'Pat Lee', eligibleAttested: true }).expect(201)).body;
    const c2 = (await request(capp).post(`/api/t/${tca}/finance/entries`).set(a).send({ kind: 'contribution', entryDate: '2026-10-02', amountMinor: 50_000, category: 'Individual', description: 'Donation', partyName: 'pat  lee' }).expect(201)).body;
    expect(c1.receiptNo).toBe('R-0001');
    expect(c2.receiptNo).toBe('R-0002');
    expect(c2.flags.map((f: { code: string }) => f.code)).toEqual(['ELIGIBILITY_NOT_CONFIRMED', 'OVER_CONTRIBUTION_LIMIT']);
    for (const [addr, lat] of [['Far St', 49.99], ['Near St', 49.951], ['Mid St', 49.97]] as const) {
      await request(capp).post(`/api/t/${tca}/ops/signs`).set(a).send({ address: addr, lat, lng: -97.2 }).expect(201);
    }
    const route = (await request(capp).get(`/api/t/${tca}/ops/signs/route`).set(a).expect(200)).body;
    expect(route.order.map((s: { address: string }) => s.address)).toEqual(['Near St', 'Mid St', 'Far St']);
  });

  it('worker app is served', async () => {
    await request(app).get('/w/').expect(200).expect(/Booth worker/);
    await request(app).get('/w/sw.js').expect(200);
  });
});
