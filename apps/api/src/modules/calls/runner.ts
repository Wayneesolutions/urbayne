import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { getRegion, type CallingHours, type Locale } from '@cs/regions';
import { checkOutbound } from '@cs/compliance';
import { voiceFor } from '@cs/channels';
import { decrypt } from '../../lib/crypto.js';
import { channelEnv, now } from '../../lib/util.js';
import type { Deps } from '../../types.js';

export const HOURLY_CAP = 2000;

const running = new Set<string>();

/** Fire-and-forget in-process runner (Phase 1). Swap for a BullMQ worker in production. */
export function kickRun(deps: Deps, tenantId: string, runId: string) {
  setImmediate(() => processRun(deps, tenantId, runId).catch((e) => console.error('[calls] run failed', runId, e)));
}

/**
 * Works through a run's queued interactions one by one. Every single call is
 * re-checked by the compliance engine right before it is placed.
 */
export async function processRun(deps: Deps, tenantId: string, runId: string): Promise<void> {
  if (running.has(runId)) return;
  running.add(runId);
  try {
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

    for (;;) {
      const next = await withTenant(deps.pool, tenantId, async (db) => {
        const [run] = await db.select({ status: schema.campaignRuns.status }).from(schema.campaignRuns).where(eq(schema.campaignRuns.id, runId));
        if (run?.status !== 'running') return 'stop' as const;
        const [i] = await db.select().from(schema.interactions)
          .where(and(eq(schema.interactions.runId, runId), eq(schema.interactions.status, 'queued'))).limit(1);
        return i ?? null;
      });
      if (next === 'stop') return;
      if (!next) break;

      await withTenant(deps.pool, tenantId, async (db) => {
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
          return;
        }

        const startedAt = now(deps);
        const result = await voice.startCall({
          to: decrypt(contact.phoneEnc, deps.env.PHONE_ENC_KEY),
          locale: item.locale,
          script: item.body,
          survey: item.survey,
          metadata: { tenantId, interactionId: next.id, runId },
        });

        const done = result.status !== 'queued';
        await db.update(schema.interactions).set({
          provider: result.provider,
          providerRef: result.providerRef,
          status: done ? result.status : 'in_progress',
          startedAt,
          endedAt: done ? new Date(startedAt.getTime() + (result.durationSec ?? 0) * 1000) : null,
          durationSec: result.durationSec ?? null,
          transcript: result.transcript ?? null,
          aiDisclosed: true, // gate 6 guarantees the script opens with the disclosure
          optedOut: Boolean(result.optOut),
          followUp: Boolean(result.followUp),
          updatedAt: new Date(),
        }).where(eq(schema.interactions.id, next.id));
        if (done) await recordOutcome(db, tenantId, next.id, contact.id, result.answers, result.optOut);
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
  } finally {
    running.delete(runId);
  }
}

/** Survey answers + opt-out handling, shared by the mock path and the provider webhook. */
export async function recordOutcome(
  db: Parameters<Parameters<typeof withTenant>[2]>[0],
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
