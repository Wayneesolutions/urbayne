import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql, arrayOverlaps } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getRegion, type CallingHours, type Locale } from '@cs/regions';
import { checkOutbound } from '@cs/compliance';
import { HttpError, ah } from '../../lib/http.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { decrypt } from '../../lib/crypto.js';
import { maskPhone, now } from '../../lib/util.js';
import { kickRun, processRun } from './runner.js';
import { canonicalJson, sha256Hex, signHash } from '../../lib/seal.js';
import { renderEvidencePdf, type EvidencePack } from '../../lib/evidence-pdf.js';
import { evidenceKey } from '../../lib/evidence-key.js';
import type { Deps } from '../../types.js';

export function callRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool } = deps;
  r.use(loadTenant(deps));

  r.get('/runs', ah(async (req, res) => {
    const t = req.tenant!;
    const rows = await withTenant(pool, t.id, async (db) => {
      const runs = await db.select().from(schema.campaignRuns).orderBy(desc(schema.campaignRuns.createdAt));
      const counts = await db.select({ runId: schema.interactions.runId, status: schema.interactions.status, n: sql<number>`count(*)::int` })
        .from(schema.interactions).groupBy(schema.interactions.runId, schema.interactions.status);
      return runs.map((run) => ({
        ...run,
        counts: Object.fromEntries(counts.filter((c) => c.runId === run.id).map((c) => [c.status, c.n])),
      }));
    });
    res.json(rows);
  }));

  r.post('/runs', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({
      name: z.string().min(1).max(120),
      contentItemId: z.string().uuid(),
      purpose: z.enum(['info', 'survey', 'reminder', 'donation']),
      audience: z.object({ geoAreaIds: z.array(z.string().uuid()).optional(), tags: z.array(z.string()).optional() }).default({}),
    }).parse(req.body);
    const run = await withTenant(pool, t.id, async (db) => {
      const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, b.contentItemId));
      if (!item || item.kind !== 'script') throw new HttpError(422, 'SCRIPT_REQUIRED', 'Pick a voice script.');
      const [row] = await db.insert(schema.campaignRuns).values({ tenantId: t.id, channel: 'voice', createdBy: req.user!.id, ...b }).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'create', entity: 'campaign_run', entityId: row!.id, after: row, ip: req.ip });
      return row;
    });
    res.status(201).json(run);
  }));

  r.post('/runs/:runId/start', requireRole('owner', 'manager'), ah(async (req, res) => {
    const t = req.tenant!;
    const wait = req.query.wait === 'true';
    const result = await withTenant(pool, t.id, async (db) => {
      const [run] = await db.select().from(schema.campaignRuns).where(eq(schema.campaignRuns.id, req.params.runId!));
      if (!run) throw new HttpError(404, 'NOT_FOUND');
      if (run.status !== 'draft' && run.status !== 'blocked') throw new HttpError(409, 'ALREADY_STARTED');
      const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, run.contentItemId));
      if (!item) throw new HttpError(404, 'CONTENT_NOT_FOUND');

      // Run-level gate: content approval/certificate, silence window, calling hours, disclosure.
      const gate = checkOutbound({
        region: getRegion(t.region),
        tenant: { id: t.id, campaignName: t.campaignName, timeZone: t.timeZone, pollCloseAt: t.pollCloseAt, callingHoursOverride: (t.callingHoursOverride as CallingHours | null) ?? null },
        channel: 'voice', purpose: run.purpose, sendAt: now(deps), scope: 'run',
        contentItem: { id: item.id, kind: item.kind, locale: item.locale as Locale, body: item.body, status: item.status, certificateNo: item.certificateNo },
        spendLimitMinor: t.spendLimitMinor,
      });
      if (!gate.allowed) {
        await db.update(schema.campaignRuns).set({ status: 'blocked', gateResult: gate, updatedAt: new Date() }).where(eq(schema.campaignRuns.id, run.id));
        await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'start_blocked', entity: 'campaign_run', entityId: run.id, after: gate, ip: req.ip });
        return { blocked: gate };
      }

      const conds = [eq(schema.contacts.optedOut, false)];
      if (run.audience.geoAreaIds?.length) conds.push(inArray(schema.contacts.geoAreaId, run.audience.geoAreaIds));
      if (run.audience.tags?.length) conds.push(arrayOverlaps(schema.contacts.tags, run.audience.tags));
      const audience = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(...conds));
      if (!audience.length) throw new HttpError(422, 'EMPTY_AUDIENCE');
      await db.insert(schema.interactions).values(audience.map((c) => ({
        tenantId: t.id, runId: run.id, contactId: c.id, channel: 'voice', direction: 'outbound' as const, contentItemId: item.id,
      })));
      await db.update(schema.campaignRuns).set({ status: 'running', gateResult: gate, startedAt: now(deps), updatedAt: new Date() }).where(eq(schema.campaignRuns.id, run.id));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'start', entity: 'campaign_run', entityId: run.id, after: { audience: audience.length, certificateNo: item.certificateNo }, ip: req.ip });
      return { audience: audience.length, warnings: gate.warnings };
    });
    if ('blocked' in result && result.blocked) return res.status(422).json({ error: 'RUN_BLOCKED', reasons: result.blocked.reasons });
    if (wait) await processRun(deps, t.id, req.params.runId!);
    else kickRun(deps, t.id, req.params.runId!);
    res.json({ status: 'running', ...result });
  }));

  for (const [action, from, to] of [['pause', 'running', 'paused'], ['resume', 'paused', 'running']] as const) {
    r.post(`/runs/:runId/${action}`, requireRole('owner', 'manager'), ah(async (req, res) => {
      const t = req.tenant!;
      const [row] = await withTenant(pool, t.id, async (db) => {
        const out = await db.update(schema.campaignRuns).set({ status: to, updatedAt: new Date() })
          .where(and(eq(schema.campaignRuns.id, req.params.runId!), eq(schema.campaignRuns.status, from))).returning();
        if (out[0]) await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action, entity: 'campaign_run', entityId: out[0].id, ip: req.ip });
        return out;
      });
      if (!row) throw new HttpError(409, `CANNOT_${action.toUpperCase()}`);
      if (to === 'running') kickRun(deps, t.id, row.id);
      res.json(row);
    }));
  }

  r.get('/runs/:runId/stats', ah(async (req, res) => {
    const t = req.tenant!;
    res.json(await withTenant(pool, t.id, (db) => runStats(db, req.params.runId!)));
  }));

  r.get('/runs/:runId/interactions', ah(async (req, res) => {
    const t = req.tenant!;
    const rows = await withTenant(pool, t.id, async (db) => db
      .select({ i: schema.interactions, phoneEnc: schema.contacts.phoneEnc, name: schema.contacts.name })
      .from(schema.interactions).leftJoin(schema.contacts, eq(schema.contacts.id, schema.interactions.contactId))
      .where(eq(schema.interactions.runId, req.params.runId!))
      .orderBy(desc(schema.interactions.updatedAt)).limit(50));
    res.json(rows.map(({ i, phoneEnc, name }) => ({
      id: i.id, status: i.status, name, phone: phoneEnc ? maskPhone(decrypt(phoneEnc, deps.env.PHONE_ENC_KEY)) : null,
      durationSec: i.durationSec, optedOut: i.optedOut, followUp: i.followUp, blockReasons: i.blockReasons, transcript: i.transcript,
    })));
  }));

  const buildPack = (t: import('../../types.js').TenantRow, runId: string) => withTenant(pool, t.id, async (db) => {
    const [run] = await db.select().from(schema.campaignRuns).where(eq(schema.campaignRuns.id, runId));
    if (!run) throw new HttpError(404, 'NOT_FOUND');
    const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, run.contentItemId));
    const stats = await runStats(db, run.id);
    const log = await db.select({ action: schema.auditLog.action, at: schema.auditLog.at, actor: schema.auditLog.actorId })
      .from(schema.auditLog).where(eq(schema.auditLog.entityId, run.id)).orderBy(schema.auditLog.at);
    return {
      generatedAt: now(deps).toISOString(),
      campaign: { name: t.campaignName, region: t.region, seat: t.seatCode, electionDate: t.electionDate, demo: t.isDemo },
      run: { id: run.id, name: run.name, purpose: run.purpose, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, audienceFilter: run.audience },
      content: item && { id: item.id, title: item.title, locale: item.locale, text: item.body, survey: item.survey, status: item.status, certificateNo: item.certificateNo, approvedBy: item.approvedBy, approvedAt: item.approvedAt },
      runGate: run.gateResult,
      results: stats,
      auditTrail: log,
    };
  });

  r.get('/runs/:runId/evidence', requireRole('owner', 'manager', 'finance_agent'), ah(async (req, res) => {
    const pack = await buildPack(req.tenant!, req.params.runId!);
    res.setHeader('Content-Disposition', `attachment; filename="evidence-${pack.run.id}.json"`);
    res.json(pack);
  }));

  /** Readable, sealed evidence pack for returning officers, MCMC and CRTC. Each download records a seal that anyone can verify. */
  r.get('/runs/:runId/evidence.pdf', requireRole('owner', 'manager', 'finance_agent'), ah(async (req, res) => {
    const t = req.tenant!;
    const pack = await buildPack(t, req.params.runId!);
    const sha256 = sha256Hex(canonicalJson(pack));
    const signature = signHash(sha256, evidenceKey(deps.env));
    const seal = await withTenant(pool, t.id, async (db) => {
      const [row] = await db.insert(schema.evidenceSeals).values({ tenantId: t.id, runId: pack.run.id, sha256, signature, generatedAt: new Date(pack.generatedAt), createdBy: req.user!.id }).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'evidence_pdf', entity: 'campaign_run', entityId: pack.run.id, after: { sealId: row!.id, sha256 }, ip: req.ip });
      return row!;
    });
    const pdf = await renderEvidencePdf(JSON.parse(JSON.stringify(pack)) as EvidencePack, {
      id: seal.id, sha256, signature, verifyUrl: `${deps.env.PUBLIC_BASE_URL}/api/public/evidence/${seal.id}`,
    });
    res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="evidence-${pack.run.id}.pdf"`);
    res.send(pdf);
  }));

  return r;
}

async function runStats(db: Parameters<Parameters<typeof withTenant>[2]>[0], runId: string) {
  const [run] = await db.select().from(schema.campaignRuns).where(eq(schema.campaignRuns.id, runId));
  if (!run) throw new HttpError(404, 'NOT_FOUND');
  const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, run.contentItemId));
  const byStatus = await db.select({ status: schema.interactions.status, n: sql<number>`count(*)::int` })
    .from(schema.interactions).where(eq(schema.interactions.runId, runId)).groupBy(schema.interactions.status);
  const [flags] = await db.select({
    optOuts: sql<number>`count(*) filter (where ${schema.interactions.optedOut})::int`,
    followUps: sql<number>`count(*) filter (where ${schema.interactions.followUp})::int`,
    avgDuration: sql<number>`coalesce(round(avg(${schema.interactions.durationSec})),0)::int`,
  }).from(schema.interactions).where(eq(schema.interactions.runId, runId));
  const answers = await db.select({ q: schema.surveyResponses.questionKey, a: schema.surveyResponses.answerValue, area: schema.geoAreas.nameEn, n: sql<number>`count(*)::int` })
    .from(schema.surveyResponses)
    .innerJoin(schema.interactions, eq(schema.interactions.id, schema.surveyResponses.interactionId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.interactions.contactId))
    .leftJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.contacts.geoAreaId))
    .where(eq(schema.interactions.runId, runId))
    .groupBy(schema.surveyResponses.questionKey, schema.surveyResponses.answerValue, schema.geoAreas.nameEn);
  const blocked = await db.select({ reasons: schema.interactions.blockReasons }).from(schema.interactions)
    .where(and(eq(schema.interactions.runId, runId), eq(schema.interactions.status, 'blocked')));
  const blockedReasons: Record<string, number> = {};
  for (const b of blocked) for (const r of (b.reasons as { code: string }[] | null) ?? []) blockedReasons[r.code] = (blockedReasons[r.code] ?? 0) + 1;

  const survey = (item?.survey ?? []).map((q) => ({
    key: q.key,
    question: q.question,
    options: q.options.map((o) => ({ value: o.value, label: o.label, count: answers.filter((x) => x.q === q.key && x.a === o.value).reduce((s, x) => s + x.n, 0) })),
    byArea: Object.entries(answers.filter((x) => x.q === q.key).reduce<Record<string, Record<string, number>>>((acc, x) => {
      const area = x.area ?? 'Unassigned';
      (acc[area] ??= {})[x.a] = (acc[area]?.[x.a] ?? 0) + x.n;
      return acc;
    }, {})).map(([area, counts]) => ({ area, counts })),
  }));
  return {
    status: run.status,
    counts: Object.fromEntries(byStatus.map((s) => [s.status, s.n])),
    total: byStatus.reduce((s, x) => s + x.n, 0),
    optOuts: flags?.optOuts ?? 0,
    followUps: flags?.followUps ?? 0,
    avgDurationSec: flags?.avgDuration ?? 0,
    blockedReasons,
    survey,
  };
}
