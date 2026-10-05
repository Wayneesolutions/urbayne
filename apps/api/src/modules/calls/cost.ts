import { eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { VapiVoice } from '@cs/channels';
import { expenseFlags } from '../finance/rules.js';
import type { Env } from '../../env.js';
import { channelEnv } from '../../lib/util.js';
import { parseEndOfCall } from './vapi-report.js';
import type { Deps, TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

/** USD (provider billing currency) to the campaign's minor units (paise / cents), using the configured rate. */
export function usdMicrosToMinor(micros: number, rate: number): number {
  return Math.round((micros / 1_000_000) * rate * 100);
}

export const fxRateFor = (env: Pick<Env, 'FX_USD_TO_INR' | 'FX_USD_TO_CAD'>, region: 'IN' | 'CA') =>
  region === 'IN' ? env.FX_USD_TO_INR : env.FX_USD_TO_CAD;

const localDate = (d: Date, timeZone: string) => d.toLocaleDateString('en-CA', { timeZone });

/**
 * Keeps ONE expense entry per call run equal to the provider cost reported so far.
 * Called every time a call's cost arrives. Returns the entry, or null when there is no cost yet
 * or the period is already signed off (a locked register is never changed).
 */
export async function syncRunCost(db: Db, tenant: TenantRow, runId: string, env: Pick<Env, 'FX_USD_TO_INR' | 'FX_USD_TO_CAD'>) {
  const [agg] = await db.select({
    micros: sql<number>`coalesce(sum(${schema.interactions.costUsdMicros}), 0)::bigint`,
    calls: sql<number>`count(${schema.interactions.costUsdMicros})::int`,
  }).from(schema.interactions).where(eq(schema.interactions.runId, runId));
  const micros = Number(agg?.micros ?? 0);
  if (micros <= 0) return null;

  const rate = fxRateFor(env, tenant.region);
  const amountMinor = usdMicrosToMinor(micros, rate);
  if (amountMinor <= 0) return null;
  const [run] = await db.select().from(schema.campaignRuns).where(eq(schema.campaignRuns.id, runId));
  const entryDate = localDate(run?.startedAt ?? new Date(), tenant.timeZone);
  if (tenant.financeLockedUntil && entryDate <= tenant.financeLockedUntil) return null;

  const description = `AI voice calls: ${run?.name ?? 'run'} (${agg!.calls} calls, provider cost US$${(micros / 1_000_000).toFixed(2)} at ${rate}/USD)`;
  const category = tenant.region === 'IN' ? 'Other' : 'Digital and phone';
  const f = schema.financeEntries;
  const [existing] = await db.select().from(f).where(sql`${f.source} = 'call_run' and ${f.sourceRef} = ${runId}`);

  const [spent] = await db.select({ n: sql<number>`coalesce(sum(${f.amountMinor}) filter (where ${f.kind} = 'expense'), 0)::bigint` }).from(f);
  const spentExcludingThis = Number(spent?.n ?? 0) - Number(existing?.amountMinor ?? 0);
  const flags = expenseFlags({ amountMinor }, { region: tenant.region, spentMinor: spentExcludingThis, limitMinor: tenant.spendLimitMinor });

  if (existing) {
    const [row] = await db.update(f).set({ amountMinor, description, flags, entryDate, updatedAt: new Date() }).where(eq(f.id, existing.id)).returning();
    await db.insert(schema.auditLog).values({ tenantId: tenant.id, action: 'update', entity: 'finance_entry', entityId: existing.id, before: existing, after: row });
    return row!;
  }
  const [row] = await db.insert(f).values({
    tenantId: tenant.id, kind: 'expense', entryDate, amountMinor, category, description, partyName: 'Voice provider (Vapi)',
    paymentMode: 'card', source: 'call_run', sourceRef: runId, flags,
  }).returning();
  await db.insert(schema.auditLog).values({ tenantId: tenant.id, action: 'create', entity: 'finance_entry', entityId: row!.id, after: row });
  return row!;
}

/**
 * Asks Vapi for a call's final cost (GET /call/{id}) and charges it to the campaign's spending register.
 * Returns 'no_cost_yet' when Vapi has not finalised billing, so the queue job can try again later.
 */
export async function reconcileCallCost(deps: Deps, tenantId: string, interactionId: string): Promise<'updated' | 'no_cost_yet' | 'skipped'> {
  const cfg = channelEnv(deps).vapi;
  if (!cfg) return 'skipped';
  const [i] = await withTenant(deps.pool, tenantId, (db) => db.select().from(schema.interactions).where(eq(schema.interactions.id, interactionId)));
  if (!i || i.provider !== 'vapi' || !i.providerRef) return 'skipped';
  const call = await new VapiVoice(cfg).getCall(i.providerRef);
  if (!call) return 'no_cost_yet';
  const micros = parseEndOfCall(call).costUsdMicros;
  if (!micros) return 'no_cost_yet';
  await withTenant(deps.pool, tenantId, async (db) => {
    await db.update(schema.interactions).set({ costUsdMicros: micros, updatedAt: new Date() }).where(eq(schema.interactions.id, interactionId));
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
    if (tenant && i.runId) await syncRunCost(db, tenant, i.runId, deps.env);
  });
  return 'updated';
}
