import '../../types.js';
import { Router, text } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { now } from '../../lib/util.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { csvCell } from '../finance/rules.js';
import { resolveArea } from '../service/tickets.js';
import { assertOpen, recordCount, recordOfficial, recordTurnout, savepoint, type Channel } from './ingest.js';
import { countingSummary, LABELS, openFlags, turnoutSummary } from './summary.js';
import type { Deps } from '../../types.js';

const VIEW = ['owner', 'manager', 'coordinator'] as const;
const REPORT = [...VIEW, 'agent_reporter'] as const;
const ADMIN = ['owner', 'manager'] as const;
const STATION_LEVELS = ['booth', 'voting_place', 'polling_station'];

const iso = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const uuid = z.string().uuid();

/** Minimal CSV: comma separated, optional double quotes, first line is the header. */
export function parseCsv(textBody: string): { header: string[]; rows: string[][] } {
  const lines = textBody.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const split = (l: string) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).filter((_, i, a) => i < a.length - 1 || _ !== '').map((c) => c.replace(/,$/, '').trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
  const [h, ...rest] = lines;
  return { header: (h ? split(h) : []).map((x) => x.toLowerCase()), rows: rest.map(split) };
}

/** Poll day and counting day: what the campaign's agents report, and how it compares with the official figures. */
export function resultsRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool } = deps;
  r.use(loadTenant(deps));
  r.use(requireRole(...REPORT));

  // ----- what an agent needs on the phone -----
  r.get('/my', ah(async (req, res) => {
    const t = req.tenant!;
    const out = await withTenant(pool, t.id, async (db) => {
      const isAgent = req.role === 'agent_reporter';
      const assigned = isAgent
        ? await db.select({ areaId: schema.resultAgents.geoAreaId, scope: schema.resultAgents.scope }).from(schema.resultAgents).where(eq(schema.resultAgents.userId, req.user!.id))
        : null;
      const stationIds = assigned ? assigned.filter((a) => a.scope === 'station').map((a) => a.areaId!) : null;
      const stations = await db.execute(sql`
        SELECT g.id AS area_id, g.name_en AS name, g.name_pa, g.name_hi, g.code, ps.electors,
               (SELECT votes_cast FROM turnout_reports r WHERE r.geo_area_id = g.id ORDER BY as_of DESC, received_at DESC LIMIT 1) AS last_votes,
               (SELECT as_of FROM turnout_reports r WHERE r.geo_area_id = g.id ORDER BY as_of DESC, received_at DESC LIMIT 1) AS last_as_of
        FROM geo_areas g LEFT JOIN polling_stations ps ON ps.geo_area_id = g.id
        WHERE ${stationIds ? (stationIds.length ? sql`g.id IN (${sql.join(stationIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql`false`) : sql`ps.id IS NOT NULL`}
        ORDER BY g.code NULLS LAST, g.name_en`);
      const candidates = await db.select({ id: schema.candidates.id, code: schema.candidates.code, name: schema.candidates.name, party: schema.candidates.party, isOurs: schema.candidates.isOurs }).from(schema.candidates).orderBy(asc(schema.candidates.code));
      return { stations: stations.rows, counting: assigned ? assigned.some((a) => a.scope === 'counting') : true, candidates };
    });
    res.json({
      archived: Boolean(t.resultsArchivedAt), serverTime: now(deps), electionDate: t.electionDate, timeZone: t.timeZone,
      stations: (out.stations as Record<string, any>[]).map((s) => ({ areaId: s.area_id, name: s.name, namePa: s.name_pa, nameHi: s.name_hi, code: s.code, electors: s.electors, lastVotes: s.last_votes, lastAsOf: s.last_as_of })),
      counting: out.counting, candidates: out.candidates,
    });
  }));

  // ----- reporting (the phone app sends batches; every report carries the phone's own id, so sending twice is safe) -----
  const channelFor = (role: string | undefined, asked?: Channel): Channel => (role === 'agent_reporter' ? 'app' : asked ?? 'app');

  r.post('/turnout/batch', ah(async (req, res) => {
    const t = req.tenant!;
    assertOpen(t);
    const b = z.object({
      channel: z.enum(['app', 'office']).optional(),
      reports: z.array(z.object({ clientUuid: uuid, areaId: uuid, votesCast: z.number().int().min(0).max(2_000_000), asOf: iso }).strict()).min(1).max(200),
    }).strict().parse(req.body);
    const received = now(deps);
    const results = await withTenant(pool, t.id, async (db) => {
      const allowed = new Set<string>();
      if (req.role === 'agent_reporter') {
        (await db.select({ a: schema.resultAgents.geoAreaId }).from(schema.resultAgents).where(and(eq(schema.resultAgents.userId, req.user!.id), eq(schema.resultAgents.scope, 'station')))).forEach((x) => allowed.add(x.a!));
      }
      const out: { clientUuid: string; status: string; flags?: string[]; error?: string }[] = [];
      for (const rep of b.reports) {
        if (req.role === 'agent_reporter' && !allowed.has(rep.areaId)) { out.push({ clientUuid: rep.clientUuid, status: 'error', error: 'NOT_YOUR_STATION' }); continue; }
        try {
          // Checks run before any write (a bad report throws an HttpError without touching the database) and the insert has its own savepoint, so no outer one is needed.
          const o = await recordTurnout(db, t.id, { clientUuid: rep.clientUuid, geoAreaId: rep.areaId, votesCast: rep.votesCast, asOf: rep.asOf, agentId: req.user!.id, channel: channelFor(req.role, b.channel) }, received);
          out.push(o.status === 'recorded' ? { clientUuid: rep.clientUuid, status: 'recorded', flags: o.flags } : { clientUuid: rep.clientUuid, status: 'duplicate' });
        } catch (e) { if (!(e instanceof HttpError)) throw e; out.push({ clientUuid: rep.clientUuid, status: 'error', error: e.code }); }
      }
      return out;
    });
    res.json({ results });
  }));

  r.post('/counts/batch', ah(async (req, res) => {
    const t = req.tenant!;
    assertOpen(t);
    const b = z.object({
      channel: z.enum(['app', 'office']).optional(),
      reports: z.array(z.object({
        clientUuid: uuid, kind: z.enum(['round', 'station']), roundNo: z.number().int().min(1).max(500).optional(), areaId: uuid.optional(),
        candidateId: uuid, votes: z.number().int().min(0).max(2_000_000), asOf: iso,
      }).strict()).min(1).max(200),
    }).strict().parse(req.body);
    const received = now(deps);
    const results = await withTenant(pool, t.id, async (db) => {
      let counting = req.role !== 'agent_reporter';
      const stations = new Set<string>();
      if (req.role === 'agent_reporter') {
        for (const a of await db.select().from(schema.resultAgents).where(eq(schema.resultAgents.userId, req.user!.id))) { if (a.scope === 'counting') counting = true; else stations.add(a.geoAreaId!); }
      }
      const out: { clientUuid: string; status: string; flags?: string[]; error?: string }[] = [];
      for (const rep of b.reports) {
        const ok = req.role !== 'agent_reporter' || (rep.kind === 'round' ? counting : Boolean(rep.areaId && stations.has(rep.areaId)));
        if (!ok) { out.push({ clientUuid: rep.clientUuid, status: 'error', error: 'NOT_YOUR_UNIT' }); continue; }
        try {
          const o = await savepoint(db, () => recordCount(db, t.id, { clientUuid: rep.clientUuid, kind: rep.kind, roundNo: rep.roundNo, geoAreaId: rep.areaId, candidateId: rep.candidateId, votes: rep.votes, asOf: rep.asOf, agentId: req.user!.id, channel: channelFor(req.role, b.channel) }, received));
          out.push(o.status === 'recorded' ? { clientUuid: rep.clientUuid, status: 'recorded', flags: o.flags } : { clientUuid: rep.clientUuid, status: 'duplicate' });
        } catch (e) { out.push({ clientUuid: rep.clientUuid, status: 'error', error: e instanceof HttpError ? e.code : 'FAILED' }); }
      }
      return out;
    });
    res.json({ results });
  }));

  // ----- the live views -----
  r.get('/turnout', requireRole(...VIEW), ah(async (req, res) => {
    const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().parse(req.query.date);
    res.json(await withTenant(pool, req.tenant!.id, (db) => turnoutSummary(db, req.tenant!, now(deps), date)));
  }));

  r.get('/counting', requireRole(...VIEW), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => countingSummary(db)));
  }));

  r.get('/flags', requireRole(...VIEW), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => openFlags(db)));
  }));

  /** "I looked at this": the flag stays on the record, it just stops showing in the open list. */
  r.post('/flags/:kind/:id/review', requireRole(...ADMIN), ah(async (req, res) => {
    const kind = z.enum(['turnout', 'count']).parse(req.params.kind);
    const id = uuid.parse(req.params.id);
    const table = kind === 'turnout' ? schema.turnoutReports : schema.countReports;
    const out = await withTenant(pool, req.tenant!.id, (db) => db.update(table).set({ reviewedAt: now(deps), reviewedBy: req.user!.id }).where(eq(table.id, id)).returning({ id: table.id }));
    if (!out.length) throw new HttpError(404, 'NOT_FOUND');
    res.json({ ok: true });
  }));

  // ----- setup: stations, agents, candidates -----
  r.get('/stations', requireRole(...VIEW), ah(async (req, res) => {
    const out = await withTenant(pool, req.tenant!.id, async (db) => {
      const configured = await db.execute(sql`
        SELECT g.id AS area_id, g.name_en AS name, g.code, g.level, ps.electors,
               coalesce((SELECT json_agg(u.name ORDER BY u.name) FROM result_agents ra JOIN users u ON u.id = ra.user_id WHERE ra.geo_area_id = g.id AND ra.scope = 'station'), '[]'::json) AS agents
        FROM polling_stations ps JOIN geo_areas g ON g.id = ps.geo_area_id ORDER BY g.code NULLS LAST, g.name_en`);
      const available = await db.execute(sql`
        SELECT g.id AS area_id, g.name_en AS name, g.code, g.level FROM geo_areas g
        WHERE g.level IN (${sql.join(STATION_LEVELS.map((l) => sql`${l}`), sql`, `)}) AND NOT EXISTS (SELECT 1 FROM polling_stations ps WHERE ps.geo_area_id = g.id) ORDER BY g.code NULLS LAST, g.name_en`);
      return { configured: configured.rows, available: available.rows };
    });
    res.json(out);
  }));

  const upsertStations = async (tenantId: string, list: { areaId?: string; areaCode?: string; electors?: number | null }[]) => withTenant(pool, tenantId, async (db) => {
    let saved = 0;
    const errors: { row: number; error: string }[] = [];
    for (const [i, s] of list.entries()) {
      const areaId = await resolveArea(db, { areaId: s.areaId, areaCode: s.areaCode });
      if (!areaId) { errors.push({ row: i + 1, error: 'AREA_NOT_FOUND' }); continue; }
      await db.insert(schema.pollingStations).values({ tenantId, geoAreaId: areaId, electors: s.electors ?? null })
        .onConflictDoUpdate({ target: [schema.pollingStations.tenantId, schema.pollingStations.geoAreaId], set: { electors: s.electors ?? null } });
      saved++;
    }
    return { saved, errors };
  });

  r.put('/stations', requireRole(...ADMIN), ah(async (req, res) => {
    const b = z.object({ stations: z.array(z.object({ areaId: uuid.optional(), areaCode: z.string().max(40).optional(), electors: z.number().int().min(0).max(100_000).nullable().optional() }).strict()).min(1).max(5000) }).strict().parse(req.body);
    res.json(await upsertStations(req.tenant!.id, b.stations));
  }));

  /** Upload: a CSV with the columns code,electors (the code is the area code of the booth or voting place). */
  r.post('/stations/csv', requireRole(...ADMIN), text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), ah(async (req, res) => {
    const { header, rows } = parseCsv(String(req.body ?? ''));
    const ci = header.indexOf('code'), ei = header.indexOf('electors');
    if (ci < 0 || ei < 0) throw new HttpError(422, 'BAD_CSV', 'The first line must have the columns: code,electors');
    if (rows.length > 5000) throw new HttpError(422, 'TOO_MANY_ROWS');
    res.json(await upsertStations(req.tenant!.id, rows.map((c) => ({ areaCode: c[ci], electors: /^\d+$/.test(c[ei] ?? '') ? Number(c[ei]) : null }))));
  }));

  r.get('/agents', requireRole(...ADMIN), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, async (db) => (await db.execute(sql`
      SELECT ra.id, ra.user_id, u.name, m.role, ra.scope, ra.geo_area_id AS area_id, g.name_en AS area, g.code
      FROM result_agents ra JOIN users u ON u.id = ra.user_id LEFT JOIN memberships m ON m.user_id = ra.user_id LEFT JOIN geo_areas g ON g.id = ra.geo_area_id
      ORDER BY u.name, ra.scope, g.code`)).rows));
  }));

  r.put('/agents', requireRole(...ADMIN), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ userId: uuid, scope: z.enum(['station', 'counting']), areaId: uuid.optional(), areaCode: z.string().max(40).optional(), remove: z.boolean().default(false) }).strict().parse(req.body);
    await withTenant(pool, t.id, async (db) => {
      const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, b.userId));
      if (!m) throw new HttpError(422, 'NOT_A_MEMBER', 'Add the person to the team first (role: results reporter).');
      const areaId = b.scope === 'station' ? await resolveArea(db, { areaId: b.areaId, areaCode: b.areaCode }) : null;
      if (b.scope === 'station' && !areaId) throw new HttpError(422, 'AREA_NOT_FOUND');
      if (b.remove) await db.delete(schema.resultAgents).where(and(eq(schema.resultAgents.userId, b.userId), eq(schema.resultAgents.scope, b.scope), areaId ? eq(schema.resultAgents.geoAreaId, areaId) : sql`${schema.resultAgents.geoAreaId} IS NULL`));
      else await db.insert(schema.resultAgents).values({ tenantId: t.id, userId: b.userId, scope: b.scope, geoAreaId: areaId }).onConflictDoNothing();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: b.remove ? 'unassign_result_agent' : 'assign_result_agent', entity: 'result_agent', entityId: b.userId, after: { scope: b.scope, areaId }, ip: req.ip });
    });
    res.json({ ok: true });
  }));

  r.get('/candidates', ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select().from(schema.candidates).orderBy(asc(schema.candidates.code))));
  }));

  const candBody = z.object({ code: z.string().regex(/^[A-Za-z0-9]{1,4}$/).transform((s) => s.toUpperCase()), name: z.string().min(1).max(120), party: z.string().max(80).optional(), isOurs: z.boolean().default(false) }).strict();
  r.post('/candidates', requireRole(...ADMIN), ah(async (req, res) => {
    const b = candBody.parse(req.body);
    try {
      const row = await withTenant(pool, req.tenant!.id, async (db) => {
        const [c] = await db.insert(schema.candidates).values({ tenantId: req.tenant!.id, ...b }).returning();
        await db.insert(schema.auditLog).values({ tenantId: req.tenant!.id, actorId: req.user!.id, action: 'create', entity: 'candidate', entityId: c!.id, after: b, ip: req.ip });
        return c!;
      });
      res.status(201).json(row);
    } catch (e: any) {
      if ((e?.cause ?? e)?.code === '23505') throw new HttpError(409, 'CODE_TAKEN', 'Another candidate already has this code.');
      throw e;
    }
  }));

  r.delete('/candidates/:id', requireRole(...ADMIN), ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    await withTenant(pool, req.tenant!.id, async (db) => {
      const [used] = await db.execute(sql`SELECT (SELECT count(*) FROM count_reports WHERE candidate_id = ${id}) + (SELECT count(*) FROM official_counts WHERE candidate_id = ${id}) AS n`).then((x) => x.rows as { n: string }[]);
      if (Number(used?.n) > 0) throw new HttpError(409, 'HAS_RESULTS', 'Results were already reported for this candidate; it cannot be removed.');
      const out = await db.delete(schema.candidates).where(eq(schema.candidates.id, id)).returning({ id: schema.candidates.id });
      if (!out.length) throw new HttpError(404, 'NOT_FOUND');
    });
    res.json({ ok: true });
  }));

  // ----- official figures (typed in or uploaded by the team; nothing is fetched from any official system) -----
  const officialEntry = z.object({
    kind: z.enum(['round', 'station']), roundNo: z.number().int().min(1).max(500).optional(), areaId: uuid.optional(), areaCode: z.string().max(40).optional(),
    candidateId: uuid.optional(), candidateCode: z.string().max(4).optional(), votes: z.number().int().min(0).max(2_000_000),
  }).strict();

  const saveOfficial = async (tenantId: string, userId: string, source: 'manual' | 'csv', note: string, entries: z.infer<typeof officialEntry>[]) => withTenant(pool, tenantId, async (db) => {
    let recorded = 0, unchanged = 0;
    const errors: { row: number; error: string }[] = [];
    for (const [i, e] of entries.entries()) {
      try {
        const cand = e.candidateId ? { id: e.candidateId } : (await db.select().from(schema.candidates).where(eq(schema.candidates.code, (e.candidateCode ?? '').toUpperCase())))[0];
        if (!cand) { errors.push({ row: i + 1, error: 'CANDIDATE_NOT_FOUND' }); continue; }
        const geoAreaId = e.kind === 'station' ? await resolveArea(db, { areaId: e.areaId, areaCode: e.areaCode }) : null;
        if (e.kind === 'station' && !geoAreaId) { errors.push({ row: i + 1, error: 'AREA_NOT_FOUND' }); continue; }
        if (e.kind === 'round' && !e.roundNo) { errors.push({ row: i + 1, error: 'ROUND_REQUIRED' }); continue; }
        const out = await savepoint(db, () => recordOfficial(db, tenantId, { kind: e.kind, roundNo: e.roundNo, geoAreaId, candidateId: cand.id, votes: e.votes }, source, note, userId));
        out.status === 'recorded' ? recorded++ : unchanged++;
      } catch (x) { errors.push({ row: i + 1, error: x instanceof HttpError ? x.code : 'FAILED' }); }
    }
    return { recorded, unchanged, errors };
  });

  r.post('/official', requireRole(...ADMIN), ah(async (req, res) => {
    const t = req.tenant!;
    assertOpen(t);
    const b = z.object({ sourceNote: z.string().trim().min(5).max(300), entries: z.array(officialEntry).min(1).max(2000) }).strict().parse(req.body);
    res.json(await saveOfficial(t.id, req.user!.id, 'manual', b.sourceNote, b.entries));
  }));

  /** CSV upload. Columns: round (or station), candidate, votes. Example first line: round,candidate,votes */
  r.post('/official/csv', requireRole(...ADMIN), text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), ah(async (req, res) => {
    const t = req.tenant!;
    assertOpen(t);
    const note = z.string().trim().min(5).max(300).parse(req.query.sourceNote);
    const { header, rows } = parseCsv(String(req.body ?? ''));
    const kindCol = header.indexOf('round') >= 0 ? 'round' : header.indexOf('station') >= 0 ? 'station' : null;
    const ui = header.indexOf(kindCol ?? ''), ci = header.indexOf('candidate'), vi = header.indexOf('votes');
    if (!kindCol || ci < 0 || vi < 0) throw new HttpError(422, 'BAD_CSV', 'The first line must have the columns: round (or station), candidate, votes');
    if (rows.length > 2000) throw new HttpError(422, 'TOO_MANY_ROWS');
    const entries = rows.map((c) => ({
      kind: kindCol as 'round' | 'station', ...(kindCol === 'round' ? { roundNo: Number(c[ui]) } : { areaCode: c[ui] }), candidateCode: c[ci], votes: Number(c[vi]),
    })).filter((e) => Number.isInteger(e.votes) && e.votes >= 0);
    res.json(await saveOfficial(t.id, req.user!.id, 'csv', note, entries as z.infer<typeof officialEntry>[]));
  }));

  r.get('/official', requireRole(...VIEW), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, async (db) => (await db.execute(sql`
      SELECT o.id, o.kind, o.round_no, g.name_en AS station, g.code AS station_code, c.code AS candidate, c.name AS candidate_name, o.votes, o.source, o.source_note, u.name AS entered_by, o.entered_at
      FROM official_counts o JOIN candidates c ON c.id = o.candidate_id LEFT JOIN geo_areas g ON g.id = o.geo_area_id LEFT JOIN users u ON u.id = o.entered_by
      ORDER BY o.entered_at DESC LIMIT 500`)).rows));
  }));

  // ----- export and archive -----
  r.get('/export.csv', requireRole(...VIEW), ah(async (req, res) => {
    const t = req.tenant!;
    const out = await withTenant(pool, t.id, async (db) => ({ turnout: await turnoutSummary(db, t, now(deps)), counting: await countingSummary(db) }));
    const lines = [`# ${LABELS.campaign}. Figures in the Official column were typed in by the team from the official site.`, ['Section', 'Place', 'Code', 'Candidate', 'Campaign reported', 'Official', 'Electors'].map(csvCell).join(',')];
    for (const s of out.turnout.stations) lines.push(['Turnout', s.name, s.code, '', s.votes, '', s.electors].map(csvCell).join(','));
    const cname = (id: string) => out.counting.candidates.find((c) => c.id === id)?.name ?? id;
    for (const rd of out.counting.rounds) for (const [cid, c] of Object.entries(rd.cells)) lines.push([`Round ${rd.roundNo}`, '', '', cname(cid), c.campaign, c.official, ''].map(csvCell).join(','));
    for (const s of out.counting.stations) for (const [cid, c] of Object.entries(s.cells)) lines.push(['Station count', s.name, s.code, cname(cid), c.campaign, c.official, s.electors].map(csvCell).join(','));
    res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="results.csv"');
    res.send(lines.join('\n'));
  }));

  /** Freezes the results for the next election and stops further reports. Owner only, with a typed confirmation. */
  r.post('/archive', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    if (!z.object({ confirm: z.literal('ARCHIVE') }).safeParse(req.body).success) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Type ARCHIVE to confirm. No more reports are accepted afterwards.');
    assertOpen(t);
    const out = await withTenant(pool, t.id, async (db) => {
      const summary = { labels: LABELS, election: { name: t.campaignName, seat: t.seatCode, date: t.electionDate }, takenAt: now(deps), turnout: await turnoutSummary(db, t, now(deps)), counting: await countingSummary(db), openFlags: (await openFlags(db)).length };
      const [row] = await db.insert(schema.resultsArchives).values({ tenantId: t.id, takenBy: req.user!.id, summary }).returning();
      await db.update(schema.tenants).set({ resultsArchivedAt: now(deps), updatedAt: now(deps) }).where(eq(schema.tenants.id, t.id));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'archive_results', entity: 'tenant', entityId: t.id, after: { archiveId: row!.id }, ip: req.ip });
      return row!;
    });
    res.status(201).json({ id: out.id, takenAt: out.takenAt });
  }));

  r.get('/archives', requireRole(...VIEW), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select({ id: schema.resultsArchives.id, takenAt: schema.resultsArchives.takenAt }).from(schema.resultsArchives).orderBy(desc(schema.resultsArchives.takenAt))));
  }));

  r.get('/archives/:id', requireRole(...VIEW), ah(async (req, res) => {
    const [row] = await withTenant(pool, req.tenant!.id, (db) => db.select().from(schema.resultsArchives).where(eq(schema.resultsArchives.id, uuid.parse(req.params.id))));
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    res.json(row);
  }));

  return r;
}
