import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getRegion, type CallingHours, type Locale } from '@cs/regions';
import { checkOutbound } from '@cs/compliance';
import { voiceFor, type CallResult } from '@cs/channels';
import { decrypt } from '../../lib/crypto.js';
import { channelEnv, now } from '../../lib/util.js';
import { planLimitReached } from '../billing/metering.js';
import type { Deps } from '../../types.js';

export const HOURLY_CAP = 2000;
/** A call that was claimed but never reported back (server crashed mid-call) is closed as failed, never retried: a voter must not be called twice. */
export const STUCK_AFTER_MS = 10 * 60_000;

/**
 * Starts a run in the background. With Redis it becomes a BullMQ job any worker can pick up;
 * without Redis (local dev, tests) it runs in this process.
 */
export async function kickRun(deps: Deps, tenantId: string, runId: string): Promise<void> {
  if (deps.queues) return deps.queues.enqueueRun(tenantId, runId);
  setImmediate(() => processRun(deps, tenantId, runId).catch((e) => console.error('[calls] run failed', runId, e)));
}

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * Works through a run's queued interactions one by one. Every single call is re-checked by the
 * compliance engine right before it is placed.
 *
 * Safe with many workers at once: each interaction is claimed with SELECT ... FOR UPDATE SKIP LOCKED
 * and marked in_progress in a short transaction BEFORE the provider is called, so two workers can
 * never place the same call. The provider call itself happens outside any database transaction.
 */
export async function processRun(deps: Deps, tenantId: string, runId: string): Promise<void> {
  const ctx = await withTenant(deps.pool, tenantId, async (db) => {
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    const [run] = await db.select().from(schema.campaignRuns).where(eq(schema.campaignRuns.id, runId));
    if (!tenant || !run) return null;
    const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, run.contentItemId));
    return item ? { tenant, run, item } : null;
  });
  if (!ctx || ctx.run.status !== 'running') return;
  const { tenant, item } = ctx;
  const region = getRegion(tenant.region);
  const voice = voiceFor({ isDemo: tenant.isDemo, region: tenant.region }, channelEnv(deps));

  await closeStuckCalls(deps, tenantId, runId);

  for (;;) {
    const step = await withTenant(deps.pool, tenantId, async (db) => {
      const [run] = await db.select({ status: schema.campaignRuns.status }).from(schema.campaignRuns).where(eq(schema.campaignRuns.id, runId));
      if (run?.status !== 'running') return { kind: 'stop' as const };
      // A capped package: when the call minutes are used up the run pauses (nothing is lost, calls stay queued) until the package is raised.
      const hit = await planLimitReached(db, tenant, 'callMinutes', now(deps));
      if (hit) {
        await db.update(schema.campaignRuns).set({ status: 'paused', updatedAt: new Date() }).where(eq(schema.campaignRuns.id, runId));
        await db.insert(schema.auditLog).values({ tenantId, action: 'usage_limit_pause', entity: 'campaign_run', entityId: runId, after: { metric: 'callMinutes', ...hit } });
        return { kind: 'stop' as const };
      }
      const [next] = await db.select().from(schema.interactions)
        .where(and(eq(schema.interactions.runId, runId), eq(schema.interactions.status, 'queued')))
        .orderBy(asc(schema.interactions.createdAt), asc(schema.interactions.id)).limit(1)
        .for('update', { skipLocked: true });
      if (!next) return { kind: 'empty' as const };

      const [contact] = next.contactId
        ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, next.contactId)) : [];
      const consents = contact ? await db.select().from(schema.consents).where(eq(schema.consents.contactId, contact.id)) : [];
      const [hour] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.interactions)
        .where(and(gt(schema.interactions.startedAt, new Date(now(deps).getTime() - 3600_000))));

      const verdict = checkOutbound({
        region,
        tenant: {
          id: tenant.id, campaignName: tenant.campaignName, timeZone: tenant.timeZone, pollCloseAt: tenant.pollCloseAt,
          callingHoursOverride: (tenant.callingHoursOverride as CallingHours | null) ?? null,
        },
        channel: 'voice',
        purpose: ctx.run.purpose,
        sendAt: now(deps),
        scope: 'send',
        contentItem: { id: item.id, kind: item.kind, locale: item.locale as Locale, body: item.body, status: item.status, certificateNo: item.certificateNo, dltTemplateId: item.dltTemplateId },
        contact: contact ? {
          id: contact.id, timeZone: contact.timeZone, optedOut: contact.optedOut,
          consents: consents.map((c) => ({ purpose: c.purpose, channel: c.channel, withdrawnAt: c.withdrawnAt })),
        } : undefined,
        hourlySentCount: hour?.n ?? 0,
        hourlyCap: HOURLY_CAP,
      });

      if (!verdict.allowed || !contact) {
        await db.update(schema.interactions).set({ status: 'blocked', blockReasons: verdict.reasons, updatedAt: new Date() })
          .where(eq(schema.interactions.id, next.id));
        return { kind: 'blocked' as const };
      }

      const startedAt = now(deps);
      await db.update(schema.interactions).set({ status: 'in_progress', startedAt, aiDisclosed: true, updatedAt: new Date() })
        .where(eq(schema.interactions.id, next.id)); // gate 6 guarantees the script opens with the disclosure
      return { kind: 'placed' as const, interactionId: next.id, contactId: contact.id, phoneEnc: contact.phoneEnc, startedAt };
    });

    if (step.kind === 'stop' || step.kind === 'empty') break;
    if (step.kind === 'blocked') continue;

    let result: CallResult;
    try {
      result = await voice.startCall({
        to: decrypt(step.phoneEnc, deps.env.PHONE_ENC_KEY),
        locale: item.locale,
        script: item.body,
        survey: item.survey,
        metadata: { tenantId, interactionId: step.interactionId, runId },
      });
    } catch (e) {
      console.error('[calls] provider error', step.interactionId, (e as Error).message);
      result = { provider: voice.name, providerRef: '', status: 'failed' };
    }

    await withTenant(deps.pool, tenantId, async (db) => {
      const done = result.status !== 'queued';
      await db.update(schema.interactions).set({
        provider: result.provider,
        providerRef: result.providerRef || null,
        status: done ? result.status : 'in_progress',
        endedAt: done ? new Date(step.startedAt.getTime() + (result.durationSec ?? 0) * 1000) : null,
        durationSec: result.durationSec ?? null,
        transcript: result.transcript ?? null,
        optedOut: Boolean(result.optOut),
        followUp: Boolean(result.followUp),
        updatedAt: new Date(),
      }).where(eq(schema.interactions.id, step.interactionId));
      if (done) await recordOutcome(db, tenantId, step.interactionId, step.contactId, result.answers, result.optOut);
    });
  }

  await withTenant(deps.pool, tenantId, async (db) => {
    const [open] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.interactions)
      .where(and(eq(schema.interactions.runId, runId), inArray(schema.interactions.status, ['queued', 'in_progress'])));
    if ((open?.n ?? 0) === 0) {
      await db.update(schema.campaignRuns).set({ status: 'completed', completedAt: now(deps), updatedAt: new Date() })
        .where(and(eq(schema.campaignRuns.id, runId), eq(schema.campaignRuns.status, 'running')));
    }
  });
}

/** Calls claimed long ago that never got a provider reference: the worker died mid-call. Close them as failed. */
async function closeStuckCalls(deps: Deps, tenantId: string, runId: string) {
  await withTenant(deps.pool, tenantId, (db: Db) => db.update(schema.interactions)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(and(
      eq(schema.interactions.runId, runId), eq(schema.interactions.status, 'in_progress'),
      isNull(schema.interactions.providerRef), lt(schema.interactions.startedAt, new Date(now(deps).getTime() - STUCK_AFTER_MS)),
    )));
}

/** Survey answers + opt-out handling, shared by the mock path and the provider webhook. */
export async function recordOutcome(
  db: Db,
  tenantId: string, interactionId: string, contactId: string,
  answers?: Record<string, string>, optOut?: boolean,
) {
  const rows = Object.entries(answers ?? {}).map(([questionKey, answerValue]) => ({ tenantId, interactionId, questionKey, answerValue }));
  if (rows.length) await db.insert(schema.surveyResponses).values(rows);
  if (optOut) {
    // Honoured instantly for every future run and channel.
    await db.update(schema.contacts).set({ optedOut: true, updatedAt: new Date() }).where(eq(schema.contacts.id, contactId));
    await db.update(schema.consents).set({ withdrawnAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.consents.contactId, contactId), isNull(schema.consents.withdrawnAt)));
  }
}
