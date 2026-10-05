import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { schema, type withTenant } from '@cs/db';
import { HttpError } from '../../lib/http.js';
import type { TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

/** Two reports for the same place within this many minutes are the same moment: the later one replaces the earlier. */
export const SAME_MOMENT_MS = 5 * 60_000;
/** A phone clock this far ahead is wrong. */
export const MAX_FUTURE_MS = 10 * 60_000;

export type Channel = 'app' | 'sms' | 'office';

/** Why a report needs a second look. Reports are never refused for these: the latest wins, and the flag stays visible. */
export const FLAG_TEXT: Record<string, string> = {
  CHANGED: 'Replaced an earlier report for the same moment with a different number',
  DECREASED: 'Lower than the same station reported earlier (turnout can only go up)',
  BELOW_LATER: 'Lower than the same station reported at a later time',
  OVER_ELECTORS: 'More votes than registered electors at this station',
  EXCEEDS_ELECTORS: 'The candidates\' votes add up to more than the registered electors',
};

/** A stable UUID made from text (for example a text message id), so a message delivered twice is one report. */
export function deriveUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Runs one item inside a savepoint: if it throws, only that item is undone and the surrounding transaction (which carries the
 * campaign id for row-level security) carries on. Do not use db.transaction() for this: inside withTenant it would commit early.
 */
let savepointSeq = 0;
export async function savepoint<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const name = sql.raw(`sp_${(savepointSeq = (savepointSeq + 1) % 1_000_000)}`); // nested savepoints each get their own name
  await db.execute(sql`SAVEPOINT ${name}`);
  try {
    const out = await fn();
    await db.execute(sql`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (e) {
    await db.execute(sql`ROLLBACK TO SAVEPOINT ${name}`);
    throw e;
  }
}

const isUniqueViolation = (e: unknown) => ((e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code) === '23505';

export function assertOpen(tenant: Pick<TenantRow, 'resultsArchivedAt'>) {
  if (tenant.resultsArchivedAt) throw new HttpError(423, 'RESULTS_ARCHIVED', 'The results were archived after the election: no more reports are accepted.');
}

export interface TurnoutInput { clientUuid: string; geoAreaId: string; votesCast: number; asOf: Date; agentId: string | null; channel: Channel }
export type TurnoutOutcome =
  | { status: 'recorded'; id: string; flags: string[]; electors: number | null; previous?: number }
  | { status: 'duplicate'; id?: string };

/**
 * Stores a turnout report (votes polled so far at a station).
 * - The same phone id sent twice, or the same number for the same moment, is ignored.
 * - A different number for the same moment replaces the earlier one (the latest wins) and is flagged CHANGED.
 * - Other odd numbers (going down, more than the electors) are kept and flagged, never silently fixed.
 */
export async function recordTurnout(db: Db, tenantId: string, input: TurnoutInput, receivedAt: Date): Promise<TurnoutOutcome> {
  const t = schema.turnoutReports;
  const [again] = await db.select({ id: t.id }).from(t).where(eq(t.clientUuid, input.clientUuid));
  if (again) return { status: 'duplicate', id: again.id };
  if (input.asOf.getTime() > receivedAt.getTime() + MAX_FUTURE_MS) throw new HttpError(422, 'TIME_IN_THE_FUTURE', 'The time on this phone is ahead of the real time.');
  const [area] = await db.select({ id: schema.geoAreas.id }).from(schema.geoAreas).where(eq(schema.geoAreas.id, input.geoAreaId));
  if (!area) throw new HttpError(422, 'STATION_NOT_FOUND');
  const [station] = await db.select().from(schema.pollingStations).where(eq(schema.pollingStations.geoAreaId, input.geoAreaId));
  const electors = station?.electors ?? null;

  const flags: string[] = [];
  const meta: Record<string, unknown> = {};
  const lo = new Date(input.asOf.getTime() - SAME_MOMENT_MS), hi = new Date(input.asOf.getTime() + SAME_MOMENT_MS);
  const [sameMoment] = await db.select().from(t).where(and(eq(t.geoAreaId, input.geoAreaId), gt(t.asOf, lo), lt(t.asOf, hi))).orderBy(desc(t.receivedAt)).limit(1);
  if (sameMoment) {
    if (sameMoment.votesCast === input.votesCast) return { status: 'duplicate', id: sameMoment.id };
    flags.push('CHANGED');
    meta.previous = { id: sameMoment.id, votes: sameMoment.votesCast, agentId: sameMoment.agentId };
  }
  const [earlier] = await db.select().from(t).where(and(eq(t.geoAreaId, input.geoAreaId), lt(t.asOf, lo))).orderBy(desc(t.asOf), desc(t.receivedAt)).limit(1);
  if (earlier && earlier.votesCast > input.votesCast) { flags.push('DECREASED'); meta.earlier = { votes: earlier.votesCast, asOf: earlier.asOf }; }
  const [later] = await db.select().from(t).where(and(eq(t.geoAreaId, input.geoAreaId), gt(t.asOf, hi))).orderBy(t.asOf, t.receivedAt).limit(1);
  if (later && later.votesCast < input.votesCast) { flags.push('BELOW_LATER'); meta.later = { votes: later.votesCast, asOf: later.asOf }; }
  if (electors !== null && input.votesCast > electors) flags.push('OVER_ELECTORS');

  // Two copies of the same report arriving at the same moment: the database's unique phone id decides, the loser is a duplicate.
  const inserted = await savepoint(db, () => db.insert(t).values({
    tenantId, geoAreaId: input.geoAreaId, agentId: input.agentId, clientUuid: input.clientUuid, votesCast: input.votesCast,
    asOf: input.asOf, receivedAt, channel: input.channel, flags, meta: Object.keys(meta).length ? meta : null,
  }).returning({ id: t.id })).catch((e) => { if (isUniqueViolation(e)) return null; throw e; });
  if (!inserted) return { status: 'duplicate' };
  return { status: 'recorded', id: inserted[0]!.id, flags, electors, previous: earlier?.votesCast };
}

export interface CountInput {
  clientUuid: string; kind: 'round' | 'station'; roundNo?: number | null; geoAreaId?: string | null; candidateId: string; votes: number;
  asOf: Date; agentId: string | null; channel: Channel;
}
export type CountOutcome = { status: 'recorded'; id: string; flags: string[] } | { status: 'duplicate'; id?: string };

const sameUnit = (c: typeof schema.countReports | typeof schema.officialCounts, i: Pick<CountInput, 'kind' | 'roundNo' | 'geoAreaId' | 'candidateId'>) => and(
  eq(c.kind, i.kind), eq(c.candidateId, i.candidateId), i.kind === 'round' ? eq(c.roundNo, i.roundNo!) : eq(c.geoAreaId, i.geoAreaId!),
);

/** Stores one candidate's votes for one round or one station. Same rules as turnout: the latest wins, a changed number is flagged. */
export async function recordCount(db: Db, tenantId: string, input: CountInput, receivedAt: Date): Promise<CountOutcome> {
  const c = schema.countReports;
  const [again] = await db.select({ id: c.id }).from(c).where(eq(c.clientUuid, input.clientUuid));
  if (again) return { status: 'duplicate', id: again.id };
  if (input.asOf.getTime() > receivedAt.getTime() + MAX_FUTURE_MS) throw new HttpError(422, 'TIME_IN_THE_FUTURE');
  if (input.kind === 'round' ? !input.roundNo || input.roundNo < 1 : !input.geoAreaId) throw new HttpError(422, 'UNIT_REQUIRED', input.kind === 'round' ? 'A round number is needed.' : 'A station is needed.');
  const [cand] = await db.select().from(schema.candidates).where(eq(schema.candidates.id, input.candidateId));
  if (!cand) throw new HttpError(422, 'CANDIDATE_NOT_FOUND');
  if (input.kind === 'station') {
    const [area] = await db.select({ id: schema.geoAreas.id }).from(schema.geoAreas).where(eq(schema.geoAreas.id, input.geoAreaId!));
    if (!area) throw new HttpError(422, 'STATION_NOT_FOUND');
  }

  const flags: string[] = [];
  const meta: Record<string, unknown> = {};
  const [latest] = await db.select().from(c).where(sameUnit(c, input)).orderBy(desc(c.asOf), desc(c.receivedAt)).limit(1);
  if (latest) {
    if (latest.votes === input.votes) return { status: 'duplicate', id: latest.id };
    flags.push('CHANGED');
    meta.previous = { id: latest.id, votes: latest.votes, agentId: latest.agentId };
  }
  if (input.kind === 'station') {
    const [station] = await db.select().from(schema.pollingStations).where(eq(schema.pollingStations.geoAreaId, input.geoAreaId!));
    if (station?.electors != null) {
      // The other candidates' latest votes at this station plus this one.
      const rows = await db.execute(sql`
        SELECT coalesce(sum(v), 0)::int AS total FROM (
          SELECT DISTINCT ON (candidate_id) votes AS v FROM count_reports
          WHERE kind = 'station' AND geo_area_id = ${input.geoAreaId} AND candidate_id <> ${input.candidateId}
          ORDER BY candidate_id, as_of DESC, received_at DESC) x`);
      const others = Number((rows.rows[0] as { total: number }).total);
      if (others + input.votes > station.electors) flags.push('EXCEEDS_ELECTORS');
    }
  }
  const inserted = await savepoint(db, () => db.insert(c).values({
    tenantId, kind: input.kind, roundNo: input.kind === 'round' ? input.roundNo! : null, geoAreaId: input.kind === 'station' ? input.geoAreaId! : null,
    candidateId: input.candidateId, votes: input.votes, agentId: input.agentId, clientUuid: input.clientUuid, channel: input.channel, asOf: input.asOf, receivedAt, flags,
    meta: Object.keys(meta).length ? meta : null,
  }).returning({ id: c.id })).catch((e) => { if (isUniqueViolation(e)) return null; throw e; });
  if (!inserted) return { status: 'duplicate' };
  return { status: 'recorded', id: inserted[0]!.id, flags };
}

export interface OfficialInput { kind: 'round' | 'station'; roundNo?: number | null; geoAreaId?: string | null; candidateId: string; votes: number }

/** Official figures, entered by a person from the official site. Append-only: the latest entry for a place and candidate is the current one. */
export async function recordOfficial(db: Db, tenantId: string, input: OfficialInput, source: 'manual' | 'csv', sourceNote: string, userId: string): Promise<{ id: string; status: 'recorded' | 'unchanged'; replaced: boolean }> {
  const o = schema.officialCounts;
  const [cand] = await db.select().from(schema.candidates).where(eq(schema.candidates.id, input.candidateId));
  if (!cand) throw new HttpError(422, 'CANDIDATE_NOT_FOUND');
  if (input.kind === 'round' ? !input.roundNo : !input.geoAreaId) throw new HttpError(422, 'UNIT_REQUIRED');
  const [prev] = await db.select().from(o).where(sameUnit(o, input)).orderBy(desc(o.enteredAt)).limit(1);
  if (prev && prev.votes === input.votes) return { id: prev.id, status: 'unchanged', replaced: false };
  const [row] = await db.insert(o).values({
    tenantId, kind: input.kind, roundNo: input.kind === 'round' ? input.roundNo! : null, geoAreaId: input.kind === 'station' ? input.geoAreaId! : null,
    candidateId: input.candidateId, votes: input.votes, source, sourceNote, enteredBy: userId,
  }).returning({ id: o.id });
  return { id: row!.id, status: 'recorded', replaced: Boolean(prev) };
}
