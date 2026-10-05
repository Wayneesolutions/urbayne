import { sql } from 'drizzle-orm';
import { schema, type withTenant } from '@cs/db';
import { FLAG_TEXT } from './ingest.js';
import type { TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];
const rows = async (db: Db, q: ReturnType<typeof sql>) => (await db.execute(q)).rows as Record<string, any>[];
/** Raw queries return timestamps as text: turn them back into dates. */
const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

export const LABELS = {
  campaign: 'Campaign reported (not official)',
  official: 'Official (typed in by the team from the official site)',
} as const;

export interface TurnoutSummary {
  label: typeof LABELS.campaign;
  pollDate: string;
  totals: { stations: number; reported: number; votes: number; electorsReported: number; electorsAll: number; turnoutPct: number | null };
  stations: { areaId: string; name: string; code: string | null; electors: number | null; votes: number | null; pct: number | null; asOf: Date | null; receivedAt: Date | null; channel: string | null; flags: string[]; openFlags: number; reports: number }[];
  timeline: { at: Date; votes: number; stations: number }[];
}

/** Turnout so far: the latest report for each station, overall turnout, and a running total by the hour. */
export async function turnoutSummary(db: Db, tenant: TenantRow, now: Date, date?: string): Promise<TurnoutSummary> {
  const pollDate = date ?? tenant.electionDate;
  const st = await rows(db, sql`
    WITH latest AS (SELECT DISTINCT ON (geo_area_id) * FROM turnout_reports ORDER BY geo_area_id, as_of DESC, received_at DESC),
         counts AS (SELECT geo_area_id, count(*)::int AS reports, count(*) FILTER (WHERE cardinality(flags) > 0 AND reviewed_at IS NULL)::int AS open_flags FROM turnout_reports GROUP BY geo_area_id)
    SELECT g.id AS area_id, g.name_en AS name, g.code, ps.electors, l.votes_cast, l.as_of, l.received_at, l.channel, l.flags, coalesce(c.open_flags, 0) AS open_flags, coalesce(c.reports, 0) AS reports
    FROM geo_areas g
    LEFT JOIN polling_stations ps ON ps.geo_area_id = g.id
    LEFT JOIN latest l ON l.geo_area_id = g.id
    LEFT JOIN counts c ON c.geo_area_id = g.id
    WHERE ps.id IS NOT NULL OR l.id IS NOT NULL
    ORDER BY g.code NULLS LAST, g.name_en`);
  const stations = st.map((x) => ({
    areaId: x.area_id as string, name: x.name as string, code: (x.code as string | null) ?? null, electors: x.electors == null ? null : Number(x.electors),
    votes: x.votes_cast == null ? null : Number(x.votes_cast), pct: x.votes_cast != null && x.electors ? Number(x.votes_cast) / Number(x.electors) : null,
    asOf: toDate(x.as_of), receivedAt: toDate(x.received_at), channel: (x.channel as string | null) ?? null,
    flags: ((x.flags as string[] | null) ?? []), openFlags: Number(x.open_flags), reports: Number(x.reports),
  }));
  const reported = stations.filter((s) => s.votes !== null);
  const votes = reported.reduce((n, s) => n + (s.votes ?? 0), 0);
  const electorsReported = reported.reduce((n, s) => n + (s.electors ?? 0), 0);

  const tl = await rows(db, sql`
    SELECT h.ts AS at, coalesce(sum(r.votes_cast), 0)::int AS votes, count(r.geo_area_id)::int AS stations
    FROM generate_series(((${pollDate}::date + time '07:00') AT TIME ZONE ${tenant.timeZone}), ((${pollDate}::date + time '19:00') AT TIME ZONE ${tenant.timeZone}), interval '1 hour') AS h(ts)
    LEFT JOIN LATERAL (SELECT DISTINCT ON (geo_area_id) geo_area_id, votes_cast FROM turnout_reports WHERE as_of <= h.ts ORDER BY geo_area_id, as_of DESC, received_at DESC) r ON true
    WHERE h.ts <= ${now.toISOString()}::timestamptz
    GROUP BY h.ts ORDER BY h.ts`);

  return {
    label: LABELS.campaign, pollDate,
    totals: { stations: stations.length, reported: reported.length, votes, electorsReported, electorsAll: stations.reduce((n, s) => n + (s.electors ?? 0), 0), turnoutPct: electorsReported ? votes / electorsReported : null },
    stations,
    timeline: tl.map((x) => ({ at: toDate(x.at)!, votes: Number(x.votes), stations: Number(x.stations) })),
  };
}

export type CellStatus = 'match' | 'differs' | 'official_missing' | 'campaign_missing';
export interface Cell { campaign: number | null; official: number | null; status: CellStatus; diff: number | null }

const cell = (campaign: number | undefined, official: number | undefined): Cell => ({
  campaign: campaign ?? null, official: official ?? null, diff: campaign !== undefined && official !== undefined ? campaign - official : null,
  status: campaign !== undefined && official !== undefined ? (campaign === official ? 'match' : 'differs') : campaign !== undefined ? 'official_missing' : 'campaign_missing',
});

export interface CountingSummary {
  labels: typeof LABELS;
  candidates: { id: string; code: string; name: string; party: string | null; isOurs: boolean }[];
  rounds: { roundNo: number; cells: Record<string, Cell>; campaignTotal: number; officialTotal: number | null; mismatches: number }[];
  cumulative: { candidateId: string; campaign: number; official: number; roundsCompared: number }[];
  lead: { campaign: Lead | null; official: Lead | null };
  stations: { areaId: string; name: string; code: string | null; electors: number | null; cells: Record<string, Cell>; campaignTotal: number; flags: string[] }[];
  mismatches: number;
  unreviewedFlags: number;
}
interface Lead { ours: number; bestOther: number; bestOtherName: string; margin: number }

/** Counting day: what the campaign's agents reported against the official figures, round by round (India) and station by station. */
export async function countingSummary(db: Db): Promise<CountingSummary> {
  const candidates = (await db.select().from(schema.candidates).orderBy(schema.candidates.code)).map((c) => ({ id: c.id, code: c.code, name: c.name, party: c.party, isOurs: c.isOurs }));
  const camp = await rows(db, sql`
    SELECT DISTINCT ON (kind, round_no, geo_area_id, candidate_id) kind, round_no, geo_area_id, candidate_id, votes, flags
    FROM count_reports ORDER BY kind, round_no, geo_area_id, candidate_id, as_of DESC, received_at DESC`);
  const off = await rows(db, sql`
    SELECT DISTINCT ON (kind, round_no, geo_area_id, candidate_id) kind, round_no, geo_area_id, candidate_id, votes
    FROM official_counts ORDER BY kind, round_no, geo_area_id, candidate_id, entered_at DESC`);
  const [fl] = await rows(db, sql`SELECT (SELECT count(*) FROM count_reports WHERE cardinality(flags) > 0 AND reviewed_at IS NULL)::int AS n`);

  type Map2 = Map<string, { campaign?: number; official?: number }>;
  const rounds = new Map<number, Map<string, { campaign?: number; official?: number }>>();
  const stations = new Map<string, Map<string, { campaign?: number; official?: number }>>();
  const stationFlags = new Map<string, Set<string>>();
  const put = (c: Record<string, any>, who: 'campaign' | 'official') => {
    const target: Map<string | number, Map<string, { campaign?: number; official?: number }>> = c.kind === 'round' ? (rounds as any) : (stations as any);
    const key = c.kind === 'round' ? Number(c.round_no) : String(c.geo_area_id);
    if (!target.has(key)) target.set(key, new Map());
    const m: Map2 = target.get(key)!;
    m.set(String(c.candidate_id), { ...(m.get(String(c.candidate_id)) ?? {}), [who]: Number(c.votes) });
    if (who === 'campaign' && c.kind === 'station' && (c.flags as string[]).length) { const set = stationFlags.get(key as string) ?? new Set<string>(); (c.flags as string[]).forEach((f) => set.add(f)); stationFlags.set(key as string, set); }
  };
  camp.forEach((c) => put(c, 'campaign'));
  off.forEach((c) => put(c, 'official'));

  const roundList = [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([roundNo, m]) => {
    const cells: Record<string, Cell> = {};
    for (const c of candidates) { const v = m.get(c.id); cells[c.id] = cell(v?.campaign, v?.official); }
    const officialAny = Object.values(cells).some((x) => x.official !== null);
    return {
      roundNo, cells, campaignTotal: Object.values(cells).reduce((n, x) => n + (x.campaign ?? 0), 0),
      officialTotal: officialAny ? Object.values(cells).reduce((n, x) => n + (x.official ?? 0), 0) : null,
      mismatches: Object.values(cells).filter((x) => x.status === 'differs').length,
    };
  });

  // Running totals only count rounds where BOTH sources have the candidate, so the two columns are comparable.
  const cumulative = candidates.map((c) => {
    let campaign = 0, official = 0, compared = 0;
    for (const r of roundList) { const x = r.cells[c.id]!; if (x.campaign !== null && x.official !== null) { campaign += x.campaign; official += x.official; compared++; } }
    return { candidateId: c.id, campaign, official, roundsCompared: compared };
  });

  const totalFor = (who: 'campaign' | 'official'): Lead | null => {
    const ours = candidates.filter((c) => c.isOurs);
    if (!ours.length || candidates.length < 2) return null;
    const sum = (id: string) => roundList.reduce((n, r) => n + (r.cells[id]![who] ?? 0), 0);
    const mine = ours.reduce((n, c) => n + sum(c.id), 0);
    const others = candidates.filter((c) => !c.isOurs).map((c) => ({ c, v: sum(c.id) })).sort((a, b) => b.v - a.v);
    if (!others.length) return null;
    if (who === 'official' && !roundList.some((r) => Object.values(r.cells).some((x) => x.official !== null))) return null;
    return { ours: mine, bestOther: others[0]!.v, bestOtherName: others[0]!.c.name, margin: mine - others[0]!.v };
  };

  const areaIds = [...stations.keys()];
  const names = areaIds.length ? await rows(db, sql`SELECT g.id, g.name_en, g.code, ps.electors FROM geo_areas g LEFT JOIN polling_stations ps ON ps.geo_area_id = g.id WHERE g.id IN (${sql.join(areaIds.map((x) => sql`${x}::uuid`), sql`, `)})`) : [];
  const stationList = areaIds.map((id) => {
    const m = stations.get(id)!;
    const cells: Record<string, Cell> = {};
    for (const c of candidates) { const v = m.get(c.id); cells[c.id] = cell(v?.campaign, v?.official); }
    const info = names.find((n) => n.id === id);
    return { areaId: id, name: (info?.name_en as string) ?? id, code: (info?.code as string | null) ?? null, electors: info?.electors == null ? null : Number(info.electors), cells, campaignTotal: Object.values(cells).reduce((n, x) => n + (x.campaign ?? 0), 0), flags: [...(stationFlags.get(id) ?? [])] };
  }).sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name));

  const mismatches = roundList.reduce((n, r) => n + r.mismatches, 0) + stationList.reduce((n, s) => n + Object.values(s.cells).filter((x) => x.status === 'differs').length, 0);
  return { labels: LABELS, candidates, rounds: roundList, cumulative, lead: { campaign: totalFor('campaign'), official: totalFor('official') }, stations: stationList, mismatches, unreviewedFlags: Number(fl?.n ?? 0) };
}

export interface FlagItem {
  kind: 'turnout' | 'count'; id: string; station: string | null; stationCode: string | null; round: number | null; candidate: string | null; votes: number;
  flags: string[]; explanation: string[]; asOf: Date; receivedAt: Date; agent: string | null; channel: string; meta: unknown;
}

/** Reports that need a second look and nobody has marked as looked at yet. */
export async function openFlags(db: Db): Promise<FlagItem[]> {
  const t = await rows(db, sql`
    SELECT r.id, g.name_en AS station, g.code, r.votes_cast AS votes, r.flags, r.as_of, r.received_at, u.name AS agent, r.channel, r.meta
    FROM turnout_reports r JOIN geo_areas g ON g.id = r.geo_area_id LEFT JOIN users u ON u.id = r.agent_id
    WHERE cardinality(r.flags) > 0 AND r.reviewed_at IS NULL ORDER BY r.received_at DESC LIMIT 500`);
  const c = await rows(db, sql`
    SELECT r.id, g.name_en AS station, g.code, r.round_no, cd.name AS candidate, r.votes, r.flags, r.as_of, r.received_at, u.name AS agent, r.channel, r.meta
    FROM count_reports r LEFT JOIN geo_areas g ON g.id = r.geo_area_id JOIN candidates cd ON cd.id = r.candidate_id LEFT JOIN users u ON u.id = r.agent_id
    WHERE cardinality(r.flags) > 0 AND r.reviewed_at IS NULL ORDER BY r.received_at DESC LIMIT 500`);
  const item = (kind: 'turnout' | 'count', x: Record<string, any>): FlagItem => ({
    kind, id: x.id, station: x.station ?? null, stationCode: x.code ?? null, round: x.round_no ?? null, candidate: x.candidate ?? null, votes: Number(x.votes),
    flags: x.flags, explanation: (x.flags as string[]).map((f) => FLAG_TEXT[f] ?? f), asOf: toDate(x.as_of)!, receivedAt: toDate(x.received_at)!, agent: x.agent ?? null, channel: x.channel, meta: x.meta,
  });
  return [...t.map((x) => item('turnout', x)), ...c.map((x) => item('count', x))].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
}
