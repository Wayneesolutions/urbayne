/** Phase 3, Tool 7: poll day turnout and counting-day results. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { createApp, resolveDeps } from '../src/app.js';
import { twilioSignature } from '../src/modules/service/inbound.js';
import { parseCsv } from '../src/modules/results/routes.js';
import { deriveUuid } from '../src/modules/results/ingest.js';
import { testEnv } from './env.js';

describe('helpers', () => {
  it('derives the same UUID from the same text, so a text delivered twice is one report', () => {
    expect(deriveUuid('SM1', 'turnout')).toBe(deriveUuid('SM1', 'turnout'));
    expect(deriveUuid('SM1', 'turnout')).not.toBe(deriveUuid('SM2', 'turnout'));
    expect(deriveUuid('SM1', 'count', 'A')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('reads simple CSV: header, quotes, comments, blank lines, a byte-order mark', () => {
    const { header, rows } = parseCsv('﻿Code,Electors\r\n# a note\r\nB001,"1,200"\r\n\r\nB002, 650 \r\n');
    expect(header).toEqual(['code', 'electors']);
    expect(rows).toEqual([['B001', '1,200'], ['B002', '650']]);
  });
});

const TWILIO = 'twilio-auth-token-0123456789';
const OWNER_URL = process.env.TEST_DATABASE_URL;
const APP_URL = process.env.TEST_APP_DATABASE_URL;
(OWNER_URL && APP_URL ? describe : describe.skip)('results (integration)', () => {
  const env = testEnv({ TWILIO_AUTH_TOKEN: TWILIO, PUBLIC_BASE_URL: 'http://t', LOG_LEVEL: 'error' });
  // Poll day, 14:30 India time. The clock is fixed so the hourly view is predictable.
  let clock = new Date('2027-02-20T14:20:00+05:30');
  const at = (hhmm: string) => new Date(`2027-02-20T${hhmm}:00+05:30`).toISOString();
  let owner: pg.Pool, pool: pg.Pool, app: ReturnType<typeof createApp>;
  const tok: Record<string, string> = {};
  const id: Record<string, string> = {};
  const area: Record<string, string> = {};
  const cand: Record<string, string> = {};
  let tenant = '';
  const as = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  const q = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
  const res = (path: string) => `/api/t/${tenant}/results${path}`;
  async function login(phone: string) {
    const r = await request(app).post('/api/auth/otp/request').send({ phone });
    return (await request(app).post('/api/auth/otp/verify').send({ phone, code: r.body.devCode })).body.accessToken as string;
  }
  const turnout = (who: string, reports: object[], extra: object = {}) => request(app).post(res('/turnout/batch')).set(as(who)).send({ reports, ...extra });
  const tr = (code: string, votesCast: number, time: string, clientUuid = randomUUID()) => ({ clientUuid, areaId: area[code], votesCast, asOf: at(time) });
  const counts = (who: string, reports: object[]) => request(app).post(res('/counts/batch')).set(as(who)).send({ reports });
  const SMS_NUMBER = '+19998880000';
  let sid = 0;
  const sms = (from: string, body: string, messageId = `SM${++sid}`) => {
    const params = { From: from, To: SMS_NUMBER, Body: body, MessageSid: messageId };
    return request(app).post('/webhooks/sms/twilio').type('form').set('X-Twilio-Signature', twilioSignature('http://t/webhooks/sms/twilio', params, TWILIO)).send(params);
  };
  const reply = (r: { text: string }) => r.text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL });
    await owner.query('TRUNCATE tenants, users, otp_codes CASCADE');
    pool = new pg.Pool({ connectionString: APP_URL });
    // The clock moves on a second at every call, like real requests do (so "received later" is always a real difference).
    app = createApp(resolveDeps({ env, pool, now: () => (clock = new Date(clock.getTime() + 1000)) }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tok.owner = await login('+919800004001');
    tenant = (await request(app).post('/api/tenants').set(as('owner')).send({ raceType: 'assembly', seatCode: 'RS-1', electionDate: '2027-02-20', campaignName: 'Results Test' })).body.id;
    const root = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ level: 'constituency', nameEn: 'Test Seat' })).body.id;
    for (const code of ['B001', 'B002', 'B003', 'B004']) {
      area[code] = (await request(app).post(`/api/t/${tenant}/geo`).set(as('owner')).send({ parentId: root, level: 'booth', nameEn: `Booth ${code}`, code })).body.id;
    }
    for (const [who, phone, role] of [['agent1', '+919800004002', 'agent_reporter'], ['agent2', '+919800004003', 'agent_reporter'], ['counter', '+919800004004', 'agent_reporter'], ['worker', '+919800004005', 'field_worker'], ['coord', '+919800004006', 'coordinator']] as const) {
      await request(app).post(`/api/t/${tenant}/members`).set(as('owner')).send({ phone, name: who, role }).expect(201);
      tok[who] = await login(phone);
      id[who] = (jwt.decode(tok[who]!) as { sub: string }).sub;
    }
    await owner.query("INSERT INTO service_numbers (tenant_id, kind, identifier, provider) VALUES ($1, 'sms', $2, 'twilio')", [tenant, SMS_NUMBER]);
  });
  afterAll(async () => { vi.restoreAllMocks(); await pool.end(); await owner.end(); });

  describe('setup', () => {
    it('candidates: unique short codes, ours is marked, a code with reports cannot be removed', async () => {
      await request(app).post(res('/candidates')).set(as('agent1')).send({ code: 'A', name: 'x' }).expect(403);
      await request(app).post(res('/candidates')).set(as('owner')).send({ code: 'toolong', name: 'x' }).expect(400);
      for (const [code, name, isOurs] of [['A', 'Our Candidate', true], ['B', 'Rival One', false], ['C', 'Rival Two', false]] as const) {
        cand[code] = (await request(app).post(res('/candidates')).set(as('owner')).send({ code: code.toLowerCase(), name, isOurs }).expect(201)).body.id;
      }
      expect((await request(app).post(res('/candidates')).set(as('owner')).send({ code: 'A', name: 'Dup' }).expect(409)).body.error).toBe('CODE_TAKEN');
      expect((await request(app).get(res('/candidates')).set(as('agent1')).expect(200)).body.map((c: { code: string }) => c.code)).toEqual(['A', 'B', 'C']);
    });

    it('stations: electors by JSON and by CSV upload, unknown codes reported per row', async () => {
      const a = (await request(app).put(res('/stations')).set(as('owner')).send({ stations: [{ areaCode: 'B001', electors: 800 }, { areaCode: 'B002', electors: 600 }, { areaCode: 'NOPE', electors: 5 }] }).expect(200)).body;
      expect(a).toEqual({ saved: 2, errors: [{ row: 3, error: 'AREA_NOT_FOUND' }] });
      const b = (await request(app).post(res('/stations/csv')).set(as('owner')).set('Content-Type', 'text/csv').send('code,electors\nB003,\nB004,500\n').expect(200)).body;
      expect(b.saved).toBe(2);
      await request(app).post(res('/stations/csv')).set(as('owner')).set('Content-Type', 'text/csv').send('a,b\n1,2').expect(422);
      await request(app).put(res('/stations')).set(as('coord')).send({ stations: [{ areaCode: 'B001', electors: 1 }] }).expect(403);
      const list = (await request(app).get(res('/stations')).set(as('coord')).expect(200)).body;
      expect(list.configured.map((s: { code: string; electors: number | null }) => [s.code, s.electors])).toEqual([['B001', 800], ['B002', 600], ['B003', null], ['B004', 500]]);
    });

    it('agents: assigned to stations or to the counting hall; only team members; field workers have no access at all', async () => {
      await request(app).get(res('/my')).set(as('worker')).expect(403);
      await request(app).put(res('/agents')).set(as('owner')).send({ userId: randomUUID(), scope: 'counting' }).expect(422);
      await request(app).put(res('/agents')).set(as('owner')).send({ userId: id.agent1, scope: 'station', areaCode: 'B001' }).expect(200);
      await request(app).put(res('/agents')).set(as('owner')).send({ userId: id.agent1, scope: 'station', areaCode: 'B003' }).expect(200);
      await request(app).put(res('/agents')).set(as('owner')).send({ userId: id.agent2, scope: 'station', areaCode: 'B002' }).expect(200);
      await request(app).put(res('/agents')).set(as('owner')).send({ userId: id.counter, scope: 'counting' }).expect(200);
      await request(app).put(res('/agents')).set(as('owner')).send({ userId: id.agent1, scope: 'station', areaCode: 'NOPE' }).expect(422);
      const my = (await request(app).get(res('/my')).set(as('agent1')).expect(200)).body;
      expect(my.stations.map((s: { code: string }) => s.code)).toEqual(['B001', 'B003']);
      expect(my.counting).toBe(false);
      expect(my.candidates).toHaveLength(3);
      expect((await request(app).get(res('/my')).set(as('counter')).expect(200)).body).toMatchObject({ counting: true, stations: [] });
      expect((await request(app).get(res('/my')).set(as('coord')).expect(200)).body.stations).toHaveLength(4); // office roles see every station
      expect((await request(app).get(res('/agents')).set(as('owner')).expect(200)).body.length).toBe(4);
    });
  });

  describe('turnout', () => {
    it('an agent reports for their own stations only; one bad report does not spoil the rest of the batch', async () => {
      const r = (await turnout('agent1', [tr('B001', 120, '08:10'), tr('B002', 50, '08:10'), tr('B003', 40, '08:10')]).expect(200)).body.results;
      expect(r.map((x: { status: string }) => x.status)).toEqual(['recorded', 'error', 'recorded']);
      expect(r[1].error).toBe('NOT_YOUR_STATION');
      expect(await q('SELECT 1 FROM turnout_reports')).toHaveLength(2);
    });

    it('sending the same report again (the phone retrying) never counts twice', async () => {
      const same = tr('B001', 300, '10:20');
      const first = (await turnout('agent1', [same]).expect(200)).body.results[0];
      const again = (await turnout('agent1', [same]).expect(200)).body.results[0];
      expect([first.status, again.status]).toEqual(['recorded', 'duplicate']);
      // The same number for the same moment with a new phone id is also just a duplicate.
      expect((await turnout('agent1', [tr('B001', 300, '10:22')]).expect(200)).body.results[0].status).toBe('duplicate');
      expect(await q('SELECT 1 FROM turnout_reports WHERE geo_area_id = $1', [area.B001])).toHaveLength(2);
    });

    it('two copies arriving at the same moment make one report', async () => {
      const same = tr('B001', 380, '11:40');
      const [a, b] = await Promise.all([turnout('agent1', [same]), turnout('agent1', [same])]);
      const statuses = [a.body.results[0].status, b.body.results[0].status].sort();
      expect(statuses).toEqual(['duplicate', 'recorded']);
      expect(await q('SELECT 1 FROM turnout_reports WHERE client_uuid = $1', [same.clientUuid])).toHaveLength(1);
    });

    it('a different number for the same moment replaces the earlier one (latest wins) and is flagged as changed', async () => {
      const r = (await turnout('agent1', [tr('B001', 330, '10:21')]).expect(200)).body.results[0];
      expect(r).toMatchObject({ status: 'recorded', flags: ['CHANGED'] });
      const [row] = await q("SELECT meta FROM turnout_reports WHERE geo_area_id = $1 AND votes_cast = 330", [area.B001]);
      expect(row.meta.previous.votes).toBe(300);
      const s = (await request(app).get(res('/turnout')).set(as('owner')).expect(200)).body;
      expect(s.stations.find((x: { code: string }) => x.code === 'B001')).toMatchObject({ votes: 380 }); // the 11:40 report is the latest by time
    });

    it('numbers that look wrong are kept and flagged, never refused or silently fixed', async () => {
      const dec = (await turnout('agent1', [tr('B001', 350, '12:30')]).expect(200)).body.results[0];
      expect(dec.flags).toEqual(['DECREASED']); // 380 at 11:40, now 350
      const over = (await turnout('agent2', [tr('B002', 700, '12:30')]).expect(200)).body.results[0];
      expect(over.flags).toEqual(['OVER_ELECTORS']); // 600 electors
      // A late-arriving offline report that is lower than something reported after it.
      await turnout('agent1', [tr('B003', 100, '12:00')]).expect(200);
      const late = (await turnout('agent1', [tr('B003', 150, '09:00')]).expect(200)).body.results[0];
      expect(late.flags).toEqual(['BELOW_LATER']); // 150 at 09:00, but 100 was reported for 12:00
      const flags = (await request(app).get(res('/flags')).set(as('owner')).expect(200)).body;
      expect(flags.filter((f: { kind: string }) => f.kind === 'turnout').length).toBeGreaterThanOrEqual(3);
      expect(flags[0].explanation.length).toBeGreaterThan(0);
    });

    it('rejects a phone clock far ahead, bad batches, and reports to other campaigns\' stations', async () => {
      const future = (await turnout('agent1', [{ clientUuid: randomUUID(), areaId: area.B001, votesCast: 400, asOf: new Date(clock.getTime() + 3_600_000).toISOString() }]).expect(200)).body.results[0];
      expect(future).toMatchObject({ status: 'error', error: 'TIME_IN_THE_FUTURE' });
      await turnout('agent1', []).expect(400);
      await turnout('agent1', [{ ...tr('B001', 1, '12:00'), extra: 1 }]).expect(400);
      await turnout('agent1', [tr('B001', -5, '12:00')]).expect(400);
      await turnout('agent1', Array.from({ length: 201 }, (_, i) => tr('B001', i, '12:00'))).expect(400);
      await request(app).post(res('/turnout/batch')).send({ reports: [tr('B001', 1, '12:00')] }).expect(401);
      expect((await turnout('agent1', [{ clientUuid: randomUUID(), areaId: randomUUID(), votesCast: 5, asOf: at('12:00') }]).expect(200)).body.results[0]).toMatchObject({ status: 'error', error: 'NOT_YOUR_STATION' });
      expect((await turnout('coord', [{ clientUuid: randomUUID(), areaId: randomUUID(), votesCast: 5, asOf: at('12:00') }]).expect(200)).body.results[0].error).toBe('STATION_NOT_FOUND');
    });

    it('the summary: latest per station, overall turnout against the electors of the stations that reported, hourly running total', async () => {
      const s = (await request(app).get(res('/turnout')).set(as('coord')).expect(200)).body;
      expect(s.label).toBe('Campaign reported (not official)');
      expect(s.pollDate).toBe('2027-02-20');
      expect(s.totals).toMatchObject({ stations: 4, reported: 3 });
      const b1 = s.stations.find((x: { code: string }) => x.code === 'B001');
      expect(b1).toMatchObject({ votes: 350, electors: 800 }); // 12:30 is the latest by time even though it is lower
      expect(b1.pct).toBeCloseTo(350 / 800, 4);
      expect(s.stations.find((x: { code: string }) => x.code === 'B004').votes).toBeNull();
      const expectedVotes = 350 + 700 + 100;
      expect(s.totals.votes).toBe(expectedVotes);
      expect(s.totals.turnoutPct).toBeCloseTo(expectedVotes / (800 + 600), 4); // B003 has no electors figure: left out of the percentage
      // Hours up to the clock (14:30): 07:00 .. 14:00 India time, a running total that includes only what was reported by then.
      expect(s.timeline).toHaveLength(8);
      expect(s.timeline[0]).toMatchObject({ votes: 0, stations: 0 });
      const at9 = s.timeline.find((t: { at: string }) => new Date(t.at).toISOString() === new Date('2027-02-20T09:00:00+05:30').toISOString());
      expect(at9.votes).toBe(120 + 150); // B001 120 (08:10); B003 reported 40 at 08:10 and 150 at 09:00: the latest by time wins
      const votes = s.timeline.map((t: { votes: number }) => t.votes);
      expect(votes.at(-1)).toBe(expectedVotes);
      await request(app).get(res('/turnout?date=2027-2-20')).set(as('owner')).expect(400);
      await request(app).get(res('/turnout')).set(as('agent1')).expect(403); // agents report; they do not see the whole picture
    });

    it('a person marks a flag as looked at: it stays on the record but leaves the open list', async () => {
      const open = (await request(app).get(res('/flags')).set(as('owner')).expect(200)).body;
      const f = open[0];
      await request(app).post(res(`/flags/${f.kind}/${f.id}/review`)).set(as('coord')).expect(403);
      await request(app).post(res(`/flags/${f.kind}/${f.id}/review`)).set(as('owner')).expect(200);
      expect((await request(app).get(res('/flags')).set(as('owner')).expect(200)).body.some((x: { id: string }) => x.id === f.id)).toBe(false);
      expect((await q('SELECT flags, reviewed_at FROM turnout_reports WHERE id = $1', [f.id]))[0].flags.length).toBeGreaterThan(0);
      await request(app).post(res(`/flags/turnout/${randomUUID()}/review`)).set(as('owner')).expect(404);
    });
  });

  describe('counting and the comparison with official figures', () => {
    const rc = (round: number, code: string, votes: number, time = '14:00', clientUuid = randomUUID()) => ({ clientUuid, kind: 'round', roundNo: round, candidateId: cand[code], votes, asOf: at(time) });

    it('the counting agent reports round by round; station agents cannot; offices can', async () => {
      const ok = (await counts('counter', [rc(1, 'A', 4521), rc(1, 'B', 3980), rc(1, 'C', 120), rc(2, 'A', 4100), rc(2, 'B', 4400), rc(2, 'C', 90)]).expect(200)).body.results;
      expect(ok.every((x: { status: string }) => x.status === 'recorded')).toBe(true);
      const no = (await counts('agent1', [rc(3, 'A', 1)]).expect(200)).body.results[0];
      expect(no).toMatchObject({ status: 'error', error: 'NOT_YOUR_UNIT' });
      const dupe = (await counts('counter', [rc(1, 'A', 4521)]).expect(200)).body.results[0];
      expect(dupe.status).toBe('duplicate'); // same number, same round: nothing new
      const changed = (await counts('counter', [rc(2, 'B', 4350)]).expect(200)).body.results[0];
      expect(changed).toMatchObject({ status: 'recorded', flags: ['CHANGED'] });
      const bad = (await counts('counter', [{ ...rc(1, 'A', 5), roundNo: undefined }]).expect(200)).body.results[0];
      expect(bad).toMatchObject({ status: 'error', error: 'UNIT_REQUIRED' });
      expect((await counts('counter', [{ ...rc(1, 'A', 5), candidateId: randomUUID() }]).expect(200)).body.results[0].error).toBe('CANDIDATE_NOT_FOUND');
    });

    it('official figures are typed in by the team with a stated source: the latest entry wins, and entries are never edited', async () => {
      await request(app).post(res('/official')).set(as('coord')).send({ sourceNote: 'ECI results page, 11:00', entries: [] }).expect(403);
      await request(app).post(res('/official')).set(as('owner')).send({ sourceNote: 'x', entries: [{ kind: 'round', roundNo: 1, candidateCode: 'A', votes: 1 }] }).expect(400); // the source must be stated
      const r = (await request(app).post(res('/official')).set(as('owner')).send({
        sourceNote: 'Official results page, read at 14:10 by the office',
        entries: [{ kind: 'round', roundNo: 1, candidateCode: 'A', votes: 4521 }, { kind: 'round', roundNo: 1, candidateCode: 'B', votes: 3990 }, { kind: 'round', roundNo: 1, candidateCode: 'C', votes: 120 },
          { kind: 'round', roundNo: 2, candidateCode: 'A', votes: 4100 }, { kind: 'round', roundNo: 9, candidateCode: 'Z', votes: 1 }],
      }).expect(200)).body;
      expect(r).toMatchObject({ recorded: 4, unchanged: 0 });
      expect(r.errors).toEqual([{ row: 5, error: 'CANDIDATE_NOT_FOUND' }]);
      const again = (await request(app).post(res('/official')).set(as('owner')).send({ sourceNote: 'Same page, read again', entries: [{ kind: 'round', roundNo: 1, candidateCode: 'A', votes: 4521 }] }).expect(200)).body;
      expect(again).toMatchObject({ recorded: 0, unchanged: 1 });
    });

    it('official figures can be uploaded as CSV', async () => {
      const csv = 'round,candidate,votes\n2,B,4350\n2,C,95\nx,A,5\n3,A,notanumber\n';
      const r = (await request(app).post(res('/official/csv?sourceNote=' + encodeURIComponent('CSV downloaded from the official site 14:20'))).set(as('owner')).set('Content-Type', 'text/csv').send(csv).expect(200)).body;
      expect(r.recorded).toBe(2);
      expect(r.errors.length).toBeGreaterThanOrEqual(1);
      await request(app).post(res('/official/csv')).set(as('owner')).set('Content-Type', 'text/csv').send(csv).expect(400); // no source note
      await request(app).post(res('/official/csv?sourceNote=ten+chars+ok')).set(as('owner')).set('Content-Type', 'text/csv').send('a,b\n1,2').expect(422);
      expect((await request(app).get(res('/official')).set(as('owner')).expect(200)).body[0]).toMatchObject({ source: 'csv', source_note: 'CSV downloaded from the official site 14:20' });
    });

    it('the comparison labels each source, shows differences round by round, and totals only what both sides have', async () => {
      const c = (await request(app).get(res('/counting')).set(as('owner')).expect(200)).body;
      expect(c.labels.campaign).toMatch(/not official/i);
      expect(c.labels.official).toMatch(/official/i);
      const r1 = c.rounds.find((r: { roundNo: number }) => r.roundNo === 1);
      expect(r1.cells[cand.A!]).toMatchObject({ campaign: 4521, official: 4521, status: 'match', diff: 0 });
      expect(r1.cells[cand.B!]).toMatchObject({ campaign: 3980, official: 3990, status: 'differs', diff: -10 });
      expect(r1.mismatches).toBe(1);
      const r2 = c.rounds.find((r: { roundNo: number }) => r.roundNo === 2);
      expect(r2.cells[cand.B!]).toMatchObject({ campaign: 4350, official: 4350, status: 'match' });
      expect(r2.cells[cand.C!]).toMatchObject({ campaign: 90, official: 95, status: 'differs' });
      expect(c.rounds.find((r: { roundNo: number }) => r.roundNo === 9)).toBeUndefined();
      const cumA = c.cumulative.find((x: { candidateId: string }) => x.candidateId === cand.A!);
      expect(cumA).toMatchObject({ campaign: 8621, official: 8621, roundsCompared: 2 });
      expect(c.lead.campaign).toMatchObject({ ours: 4521 + 4100, bestOther: 3980 + 4350, margin: 8621 - 8330 });
      expect(c.lead.official).toMatchObject({ ours: 8621, margin: 8621 - (3990 + 4350) });
      expect(c.mismatches).toBeGreaterThanOrEqual(2);
      expect(c.unreviewedFlags).toBeGreaterThanOrEqual(1); // the changed round 2 number for B
      await request(app).get(res('/counting')).set(as('counter')).expect(403);
    });

    it('station counts (Canada voting places, India booth-wise) are flagged when they add up to more than the electors', async () => {
      const ok = (await counts('coord', [
        { clientUuid: randomUUID(), kind: 'station', areaId: area.B004, candidateId: cand.A, votes: 300, asOf: at('14:00') },
        { clientUuid: randomUUID(), kind: 'station', areaId: area.B004, candidateId: cand.B, votes: 150, asOf: at('14:00') },
      ]).expect(200)).body.results;
      expect(ok.map((x: { flags: string[] }) => x.flags)).toEqual([[], []]); // 450 of 500 electors
      const over = (await counts('coord', [{ clientUuid: randomUUID(), kind: 'station', areaId: area.B004, candidateId: cand.C, votes: 100, asOf: at('14:00') }]).expect(200)).body.results[0];
      expect(over.flags).toEqual(['EXCEEDS_ELECTORS']); // 550 of 500
      const c = (await request(app).get(res('/counting')).set(as('owner')).expect(200)).body;
      expect(c.stations[0]).toMatchObject({ code: 'B004', electors: 500, campaignTotal: 550, flags: ['EXCEEDS_ELECTORS'] });
    });

    it('a candidate with results cannot be removed', async () => {
      expect((await request(app).delete(res(`/candidates/${cand.A}`)).set(as('owner')).expect(409)).body.error).toBe('HAS_RESULTS');
      const spare = (await request(app).post(res('/candidates')).set(as('owner')).send({ code: 'Z9', name: 'Spare' }).expect(201)).body.id;
      await request(app).delete(res(`/candidates/${spare}`)).set(as('owner')).expect(200);
    });
  });

  describe('reporting by text message', () => {
    const agent1 = '+919800004002', counter = '+919800004004', stranger = '+919811400001';

    it('a team member texts turnout; the reply confirms it with the percentage, and the report shows as coming from SMS', async () => {
      const r = await sms(agent1, 'VOTE B001 420').expect(200);
      expect(reply(r)).toContain('Recorded B001: 420 votes (53% of 800)');
      expect((await q("SELECT channel, agent_id FROM turnout_reports WHERE votes_cast = 420"))[0]).toMatchObject({ channel: 'sms', agent_id: id.agent1 });
    });

    it('the same message delivered twice is one report; an odd number is recorded with a note', async () => {
      expect(reply(await sms(agent1, 'VOTE B001 421', 'SM-same').expect(200))).toContain('Recorded');
      expect(reply(await sms(agent1, 'VOTE B001 421', 'SM-same').expect(200))).toContain('Already recorded');
      expect(await q('SELECT 1 FROM turnout_reports WHERE votes_cast = 421')).toHaveLength(1);
      expect(reply(await sms(agent1, 'turnout B001 100').expect(200))).toMatch(/lower than your earlier/);
    });

    it('wrong stations, wrong senders and wrong formats get a clear answer and record nothing', async () => {
      expect(reply(await sms(agent1, 'VOTE B002 10').expect(200))).toContain('not set up to report for B002');
      expect(reply(await sms(agent1, 'VOTE B999 10').expect(200))).toContain('not found');
      expect(reply(await sms(agent1, 'VOTE B001').expect(200))).toContain('Turnout: VOTE');
      expect(reply(await sms(agent1, 'VOTE B001 12x').expect(200))).toContain('Turnout: VOTE');
      expect(reply(await sms(agent1, 'COUNT R1 A 100 B 100').expect(200))).toContain('not set up to report counting rounds');
      expect(await q("SELECT 1 FROM turnout_reports WHERE votes_cast IN (10, 12, 100) AND channel = 'sms' AND votes_cast = 10")).toHaveLength(0);
    });

    it('counting by text: a round, or a station; candidate codes and numbers must pair up', async () => {
      expect(reply(await sms(counter, 'COUNT R3 A 4000 B 3900 C 80').expect(200))).toBe('Recorded round 3: A 4000, B 3900, C 80.');
      expect((await q("SELECT votes FROM count_reports WHERE kind = 'round' AND round_no = 3 ORDER BY votes DESC")).map((x) => x.votes)).toEqual([4000, 3900, 80]);
      expect(reply(await sms(counter, 'COUNT R3 A 4001 B 3900').expect(200))).toContain('A replaced your earlier number');
      expect(reply(await sms(counter, 'COUNT R3 A 4000 B').expect(200))).toContain('in pairs');
      expect(reply(await sms(counter, 'COUNT R3 Q 4000').expect(200))).toContain('Candidate Q not found');
      expect(reply(await sms(counter, 'COUNT R3 A lots').expect(200))).toContain('not a vote count');
      expect(reply(await sms(counter, 'COUNT B003 A 100 B 90').expect(200))).toContain('not set up to report for B003'); // counter only has the counting hall
      expect(reply(await sms(agent1, 'COUNT B003 A 100 B 90').expect(200))).toBe('Recorded B003: A 100, B 90.');
    });

    it('people who are not on the team: a text starting with "votes" is still a resident\'s request, not a report', async () => {
      const r = await sms(stranger, 'Votes were bought in our street, please look into it urgently').expect(200);
      expect(reply(r)).toMatch(/Request T-\d{4} received|^$/);
      expect(await q("SELECT 1 FROM tickets WHERE title LIKE 'Votes were bought%'")).toHaveLength(1);
      expect(await q("SELECT 1 FROM turnout_reports WHERE channel = 'sms' AND agent_id IS NULL")).toHaveLength(0);
    });
  });

  describe('export and archive', () => {
    it('the export labels campaign and official columns', async () => {
      const csv = (await request(app).get(res('/export.csv')).set(as('owner')).expect(200)).text;
      expect(csv).toMatch(/Campaign reported \(not official\)/);
      expect(csv.split('\n')[1]).toBe('Section,Place,Code,Candidate,Campaign reported,Official,Electors');
      expect(csv).toContain('Round 1');
      await request(app).get(res('/export.csv')).set(as('agent1')).expect(403);
    });

    it('only the owner archives, with a typed confirmation; afterwards no report is accepted, by app or by text', async () => {
      await request(app).post(res('/archive')).set(as('coord')).send({ confirm: 'ARCHIVE' }).expect(403);
      expect((await request(app).post(res('/archive')).set(as('owner')).send({}).expect(422)).body.error).toBe('CONFIRMATION_REQUIRED');
      const a = (await request(app).post(res('/archive')).set(as('owner')).send({ confirm: 'ARCHIVE' }).expect(201)).body;
      expect((await request(app).get(res('/archives')).set(as('coord')).expect(200)).body.map((x: { id: string }) => x.id)).toEqual([a.id]);
      const full = (await request(app).get(res(`/archives/${a.id}`)).set(as('coord')).expect(200)).body;
      expect(full.summary.labels.campaign).toMatch(/not official/);
      expect(full.summary.turnout.totals.reported).toBe(3);
      expect(full.summary.counting.rounds.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(full.summary)).not.toMatch(/\+91\d{8}/); // no phone numbers in an archive

      expect((await turnout('agent1', [tr('B001', 500, '14:20')]).expect(423)).body.error).toBe('RESULTS_ARCHIVED');
      await counts('counter', [{ clientUuid: randomUUID(), kind: 'round', roundNo: 4, candidateId: cand.A, votes: 1, asOf: at('14:20') }]).expect(423);
      await request(app).post(res('/official')).set(as('owner')).send({ sourceNote: 'late entry here', entries: [{ kind: 'round', roundNo: 1, candidateCode: 'A', votes: 1 }] }).expect(423);
      expect(reply(await sms('+919800004002', 'VOTE B001 600').expect(200))).toContain('closed');
      await request(app).post(res('/archive')).set(as('owner')).send({ confirm: 'ARCHIVE' }).expect(423);
      // The views still work: the archived results can be read.
      await request(app).get(res('/turnout')).set(as('owner')).expect(200);
    });
  });
});
