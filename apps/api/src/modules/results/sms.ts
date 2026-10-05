import { and, eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { hashPhone } from '../../lib/crypto.js';
import { HttpError } from '../../lib/http.js';
import { now } from '../../lib/util.js';
import { resolveArea } from '../service/tickets.js';
import { deriveUuid, recordCount, recordTurnout, assertOpen, type Channel } from './ingest.js';
import type { Deps } from '../../types.js';

/** True when the sender is on this campaign's team (so their "VOTE ..." text is a results report, not a resident's request). */
export async function isTeamMember(deps: Deps, tenantId: string, fromPhone: string): Promise<boolean> {
  const phoneHash = hashPhone(fromPhone, deps.env.PHONE_HASH_KEY);
  return withTenant(deps.pool, tenantId, async (db) => {
    const [who] = await db.select({ role: schema.memberships.role }).from(schema.users)
      .innerJoin(schema.memberships, and(eq(schema.memberships.userId, schema.users.id), eq(schema.memberships.tenantId, tenantId))).where(eq(schema.users.phoneHash, phoneHash));
    return Boolean(who && [...OFFICE_ROLES, 'agent_reporter'].includes(who.role));
  });
}

/** First words that mean "this text is a results report". */
export const RESULTS_COMMAND = /^(vote|votes|turnout|poll|count)\b/i;

const HELP = 'Turnout: VOTE B045 312 (station code, total votes so far). Counting: COUNT R3 A 4521 B 3980 (round, candidate code, votes) or COUNT B045 A 120 B 98 (station).';
const OFFICE_ROLES = ['owner', 'manager', 'coordinator'];

/**
 * An agent's text message: turnout (VOTE code number) or counting (COUNT R3 A 4521 B 3980). The sender is recognised by phone number
 * and must be a team member; field agents may only report for the stations they are assigned to. Returns the reply text.
 */
export async function handleResultsSms(deps: Deps, tenantId: string, fromPhone: string, body: string, messageId: string): Promise<string> {
  const phoneHash = hashPhone(fromPhone, deps.env.PHONE_HASH_KEY);
  const tokens = body.trim().split(/[\s,;:]+/).filter(Boolean);
  const cmd = tokens[0]!.toLowerCase();
  const receivedAt = now(deps);

  const reply = withTenant(deps.pool, tenantId, async (db): Promise<string> => {
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    const [who] = await db.select({ userId: schema.users.id, role: schema.memberships.role }).from(schema.users)
      .innerJoin(schema.memberships, and(eq(schema.memberships.userId, schema.users.id), eq(schema.memberships.tenantId, tenantId))).where(eq(schema.users.phoneHash, phoneHash));
    if (!tenant || !who || ![...OFFICE_ROLES, 'agent_reporter'].includes(who.role)) return 'This number is not registered to report results for this campaign.';
    try { assertOpen(tenant); } catch { return 'Results are closed for this election: nothing more can be reported.'; }
    const channel: Channel = 'sms';
    const isAgent = who.role === 'agent_reporter';

    const mayStation = async (areaId: string) => {
      if (!isAgent) return true;
      const [a] = await db.select().from(schema.resultAgents).where(and(eq(schema.resultAgents.userId, who.userId), eq(schema.resultAgents.scope, 'station'), eq(schema.resultAgents.geoAreaId, areaId)));
      return Boolean(a);
    };
    const mayCount = async () => {
      if (!isAgent) return true;
      const [a] = await db.select().from(schema.resultAgents).where(and(eq(schema.resultAgents.userId, who.userId), eq(schema.resultAgents.scope, 'counting')));
      return Boolean(a);
    };

    if (cmd === 'count') {
      const rest = tokens.slice(1);
      const first = rest[0];
      if (!first) return HELP;
      const roundMatch = /^r(\d{1,3})$/i.exec(first);
      let unit: { kind: 'round'; roundNo: number } | { kind: 'station'; areaId: string; code: string };
      if (roundMatch) {
        if (!(await mayCount())) return 'You are not set up to report counting rounds.';
        unit = { kind: 'round', roundNo: Number(roundMatch[1]) };
      } else {
        const areaId = await resolveArea(db, { areaCode: first });
        if (!areaId) return `Station ${first.toUpperCase()} not found. ${HELP}`;
        if (!(await mayStation(areaId))) return `You are not set up to report for ${first.toUpperCase()}.`;
        unit = { kind: 'station', areaId, code: first.toUpperCase() };
      }
      const pairs = rest.slice(1);
      if (pairs.length < 2 || pairs.length % 2) return `Send candidate code and votes in pairs. ${HELP}`;
      const out: string[] = [];
      const notes: string[] = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const code = pairs[i]!.toUpperCase(), n = pairs[i + 1]!;
        if (!/^\d{1,7}$/.test(n)) return `"${n}" is not a vote count. ${HELP}`;
        const [cand] = await db.select().from(schema.candidates).where(eq(schema.candidates.code, code));
        if (!cand) return `Candidate ${code} not found. ${HELP}`;
        const r = await recordCount(db, tenantId, {
          clientUuid: deriveUuid(messageId, 'count', code), kind: unit.kind, roundNo: unit.kind === 'round' ? unit.roundNo : null, geoAreaId: unit.kind === 'station' ? unit.areaId : null,
          candidateId: cand.id, votes: Number(n), asOf: receivedAt, agentId: who.userId, channel,
        }, receivedAt);
        out.push(`${code} ${n}`);
        if (r.status === 'recorded' && r.flags.includes('CHANGED')) notes.push(`${code} replaced your earlier number`);
        if (r.status === 'recorded' && r.flags.includes('EXCEEDS_ELECTORS')) notes.push('totals exceed the electors');
      }
      return `Recorded ${unit.kind === 'round' ? `round ${unit.roundNo}` : unit.code}: ${out.join(', ')}.${notes.length ? ` Note: ${[...new Set(notes)].join('; ')}.` : ''}`;
    }

    // Turnout: VOTE <station code> <votes so far>
    const [code, n] = [tokens[1], tokens[2]];
    if (!code || !n || tokens.length > 3 || !/^\d{1,7}$/.test(n)) return HELP;
    const areaId = await resolveArea(db, { areaCode: code });
    if (!areaId) return `Station ${code.toUpperCase()} not found. ${HELP}`;
    if (!(await mayStation(areaId))) return `You are not set up to report for ${code.toUpperCase()}.`;
    const r = await recordTurnout(db, tenantId, { clientUuid: deriveUuid(messageId, 'turnout'), geoAreaId: areaId, votesCast: Number(n), asOf: receivedAt, agentId: who.userId, channel }, receivedAt);
    if (r.status === 'duplicate') return `Already recorded: ${code.toUpperCase()} ${n}.`;
    const pct = r.electors ? ` (${Math.round((Number(n) / r.electors) * 100)}% of ${r.electors})` : '';
    const notes: string[] = [];
    if (r.flags.includes('CHANGED')) notes.push('replaced your earlier number');
    if (r.flags.includes('DECREASED')) notes.push(`lower than your earlier ${r.previous}; send again if this is a correction`);
    if (r.flags.includes('OVER_ELECTORS')) notes.push(`more than the ${r.electors} electors`);
    return `Recorded ${code.toUpperCase()}: ${n} votes${pct}.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`;
  });
  // A report that cannot be recorded (for example a wrong phone clock) is answered, and nothing from that text is kept.
  return reply.catch((e) => { if (e instanceof HttpError) return `Could not record that (${e.code}). ${HELP}`; throw e; });
}
