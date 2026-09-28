import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { contributionFlags, csvCell, expenseFlags, normaliseParty } from './rules.js';
import type { Deps, TenantRow } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];
const WRITERS = ['owner', 'manager', 'finance_agent'] as const;
const SIGNERS = ['finance_agent', 'owner'] as const;

const IN_CATEGORIES = ['Public meeting / rally', 'Vehicles', 'Printing and posters', 'Advertising (print, electronic, social media)', 'Campaign workers', 'Election office', 'Star campaigner', 'Other'];
const CA_CATEGORIES = ['Advertising', 'Signs', 'Printing', 'Office', 'Events', 'Digital and phone', 'Professional fees', 'Other'];

async function totals(db: Db) {
  const [x] = await db.select({
    expense: sql<number>`coalesce(sum(${schema.financeEntries.amountMinor}) filter (where ${schema.financeEntries.kind} = 'expense'), 0)::bigint`,
    contribution: sql<number>`coalesce(sum(${schema.financeEntries.amountMinor}) filter (where ${schema.financeEntries.kind} = 'contribution'), 0)::bigint`,
    entries: sql<number>`count(*)::int`,
    flagged: sql<number>`count(*) filter (where jsonb_array_length(${schema.financeEntries.flags}) > 0)::int`,
  }).from(schema.financeEntries);
  return { expense: Number(x?.expense ?? 0), contribution: Number(x?.contribution ?? 0), entries: x?.entries ?? 0, flagged: x?.flagged ?? 0 };
}

export function financeRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool } = deps;
  r.use(loadTenant(deps));
  r.use(requireRole('owner', 'manager', 'finance_agent'));

  r.get('/summary', ah(async (req, res) => {
    const t = req.tenant!;
    const out = await withTenant(pool, t.id, async (db) => {
      const tot = await totals(db);
      const byCat = await db.select({ kind: schema.financeEntries.kind, category: schema.financeEntries.category, minor: sql<number>`sum(${schema.financeEntries.amountMinor})::bigint` })
        .from(schema.financeEntries).groupBy(schema.financeEntries.kind, schema.financeEntries.category);
      const [signoff] = await db.select().from(schema.financeSignoffs).orderBy(desc(schema.financeSignoffs.signedAt)).limit(1);
      return {
        currency: t.region === 'IN' ? 'INR' : 'CAD', limitMinor: t.spendLimitMinor, contributionLimitMinor: t.contributionLimitMinor,
        ...tot, share: t.spendLimitMinor ? tot.expense / t.spendLimitMinor : null,
        byCategory: byCat.map((c) => ({ ...c, minor: Number(c.minor) })), lockedUntil: t.financeLockedUntil, lastSignoff: signoff ?? null,
        categories: t.region === 'IN' ? IN_CATEGORIES : CA_CATEGORIES,
      };
    });
    res.json(out);
  }));

  r.get('/entries', ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select().from(schema.financeEntries).orderBy(desc(schema.financeEntries.entryDate), desc(schema.financeEntries.createdAt))));
  }));

  r.post('/entries', requireRole(...WRITERS), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({
      kind: z.enum(['contribution', 'expense']), entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amountMinor: z.number().int().positive(),
      category: z.string().min(1).max(80), description: z.string().min(1).max(300), partyName: z.string().min(1).max(160), partyAddress: z.string().max(300).optional(),
      billNo: z.string().max(60).optional(), quantity: z.number().positive().optional(), unitRateMinor: z.number().int().positive().optional(),
      rateListId: z.string().uuid().optional(), paymentMode: z.enum(['cash', 'cheque', 'bank', 'upi', 'card', 'other']).optional(),
      eligibleAttested: z.boolean().default(false), receiptFile: z.string().max(300).optional(),
    }).parse(req.body);
    if (t.financeLockedUntil && b.entryDate <= t.financeLockedUntil) throw new HttpError(423, 'PERIOD_LOCKED', `Entries up to ${t.financeLockedUntil} are locked.`);
    const row = await withTenant(pool, t.id, (db) => insertEntry(db, t, { ...b, quantity: b.quantity, createdBy: req.user!.id }));
    res.status(201).json(row);
  }));

  r.delete('/entries/:id', requireRole(...WRITERS), ah(async (req, res) => {
    const t = req.tenant!;
    const reason = z.object({ reason: z.string().min(5) }).parse(req.body ?? {}).reason;
    await withTenant(pool, t.id, async (db) => {
      const [e] = await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.id, req.params.id!));
      if (!e) throw new HttpError(404, 'NOT_FOUND');
      if (t.financeLockedUntil && e.entryDate <= t.financeLockedUntil) throw new HttpError(423, 'PERIOD_LOCKED');
      await db.delete(schema.financeEntries).where(eq(schema.financeEntries.id, e.id));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'delete', entity: 'finance_entry', entityId: e.id, before: e, after: { reason }, ip: req.ip });
    });
    res.json({ ok: true });
  }));

  r.get('/rate-list', ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select().from(schema.rateList).orderBy(asc(schema.rateList.item))));
  }));
  r.post('/rate-list', requireRole(...WRITERS), ah(async (req, res) => {
    const b = z.object({ item: z.string().min(1).max(120), unit: z.string().min(1).max(40), rateMinor: z.number().int().positive() }).parse(req.body);
    const [row] = await withTenant(pool, req.tenant!.id, (db) => db.insert(schema.rateList).values({ tenantId: req.tenant!.id, ...b }).returning());
    res.status(201).json(row);
  }));

  /** Sign-off by the official / election agent: freezes the period and allows export. */
  r.post('/signoff', requireRole(...SIGNERS), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
    const out = await withTenant(pool, t.id, async (db) => {
      const [x] = await db.select({
        expense: sql<number>`coalesce(sum(${schema.financeEntries.amountMinor}) filter (where ${schema.financeEntries.kind} = 'expense'), 0)::bigint`,
        contribution: sql<number>`coalesce(sum(${schema.financeEntries.amountMinor}) filter (where ${schema.financeEntries.kind} = 'contribution'), 0)::bigint`,
        entries: sql<number>`count(*)::int`,
      }).from(schema.financeEntries).where(lte(schema.financeEntries.entryDate, b.periodTo));
      const [s] = await db.insert(schema.financeSignoffs).values({
        tenantId: t.id, periodTo: b.periodTo, expenseMinor: Number(x!.expense), contributionMinor: Number(x!.contribution), entries: x!.entries, signedBy: req.user!.id,
      }).returning();
      await db.update(schema.tenants).set({ financeLockedUntil: b.periodTo, updatedAt: new Date() }).where(eq(schema.tenants.id, t.id));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'finance_signoff', entity: 'finance', entityId: s!.id, after: s, ip: req.ip });
      return s;
    });
    res.status(201).json(out);
  }));

  /** Register export (CSV). Only for periods the agent has signed off. */
  r.get('/export.csv', requireRole(...SIGNERS), ah(async (req, res) => {
    const t = req.tenant!;
    const kind = z.enum(['expense', 'contribution']).parse(req.query.kind ?? 'expense');
    const rows = await withTenant(pool, t.id, async (db) => {
      const [s] = await db.select().from(schema.financeSignoffs).orderBy(desc(schema.financeSignoffs.signedAt)).limit(1);
      if (!s) throw new HttpError(409, 'SIGNOFF_REQUIRED', 'The finance agent must sign off a period before it can be exported.');
      const list = await db.select().from(schema.financeEntries)
        .where(and(eq(schema.financeEntries.kind, kind), lte(schema.financeEntries.entryDate, s.periodTo))).orderBy(asc(schema.financeEntries.entryDate));
      return { s, list };
    });
    const money = (m: number | null) => (m == null ? '' : (m / 100).toFixed(2));
    const head = kind === 'expense'
      ? ['Date', 'Category', 'Description', 'Paid to', 'Address', 'Bill / invoice no.', 'Quantity', 'Rate', 'Amount', 'Mode', 'Source', 'Flags']
      : ['Date', 'Receipt no.', 'Received from', 'Address', 'Description', 'Amount', 'Mode', 'Eligibility confirmed', 'Flags'];
    const lines = rows.list.map((e) => (kind === 'expense'
      ? [e.entryDate, e.category, e.description, e.partyName, e.partyAddress, e.billNo, e.quantity, money(e.unitRateMinor), money(e.amountMinor), e.paymentMode, e.source, e.flags.map((f) => f.code).join(' ')]
      : [e.entryDate, e.receiptNo, e.partyName, e.partyAddress, e.description, money(e.amountMinor), e.paymentMode, e.eligibleAttested ? 'yes' : 'no', e.flags.map((f) => f.code).join(' ')]).map(csvCell).join(','));
    const note = `# ${t.campaignName} — ${kind} register up to ${rows.s.periodTo}, signed off ${rows.s.signedAt.toISOString()}. Check the column layout against the format your election authority requires.`;
    res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${kind}-register-${rows.s.periodTo}.csv"`);
    res.send([note, head.map(csvCell).join(','), ...lines].join('\n'));
  }));

  return r;
}

interface EntryInput {
  kind: 'contribution' | 'expense'; entryDate: string; amountMinor: number; category: string; description: string; partyName: string;
  partyAddress?: string; billNo?: string; quantity?: number; unitRateMinor?: number; rateListId?: string; paymentMode?: 'cash' | 'cheque' | 'bank' | 'upi' | 'card' | 'other';
  eligibleAttested?: boolean; receiptFile?: string; createdBy: string; source?: 'manual' | 'event' | 'call_run'; sourceRef?: string;
}

export async function insertEntry(db: Db, t: TenantRow, b: EntryInput) {
  const tot = await totals(db);
  let flags;
  let receiptNo: string | null = null;
  if (b.kind === 'expense') {
    const [rl] = b.rateListId ? await db.select().from(schema.rateList).where(eq(schema.rateList.id, b.rateListId)) : [];
    flags = expenseFlags({ amountMinor: b.amountMinor, billNo: b.billNo, quantity: b.quantity, unitRateMinor: b.unitRateMinor, listRateMinor: rl?.rateMinor },
      { region: t.region, spentMinor: tot.expense, limitMinor: t.spendLimitMinor });
  } else {
    const prior = await db.select({ name: schema.financeEntries.partyName, amt: schema.financeEntries.amountMinor }).from(schema.financeEntries).where(eq(schema.financeEntries.kind, 'contribution'));
    const priorFromSame = prior.filter((p) => normaliseParty(p.name) === normaliseParty(b.partyName)).reduce((s, p) => s + Number(p.amt), 0);
    flags = contributionFlags({ amountMinor: b.amountMinor, eligibleAttested: Boolean(b.eligibleAttested), partyName: b.partyName, paymentMode: b.paymentMode },
      { region: t.region, priorFromSameMinor: priorFromSame, perContributorLimitMinor: t.contributionLimitMinor });
    receiptNo = `R-${String(prior.length + 1).padStart(4, '0')}`;
  }
  const [row] = await db.insert(schema.financeEntries).values({
    tenantId: t.id, kind: b.kind, entryDate: b.entryDate, amountMinor: b.amountMinor, category: b.category, description: b.description,
    partyName: b.partyName, partyAddress: b.partyAddress, billNo: b.billNo, quantity: b.quantity != null ? String(b.quantity) : null,
    unitRateMinor: b.unitRateMinor, rateListId: b.rateListId, paymentMode: b.paymentMode, eligibleAttested: Boolean(b.eligibleAttested),
    receiptNo, receiptFile: b.receiptFile, source: b.source ?? 'manual', sourceRef: b.sourceRef, flags, createdBy: b.createdBy,
  }).returning();
  await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: b.createdBy, action: 'create', entity: 'finance_entry', entityId: row!.id, after: row });
  return row!;
}

/** Called when an event is marked done with a cost. One expense per event, never duplicated. */
export async function upsertEventExpense(db: Db, t: TenantRow, ev: typeof schema.events.$inferSelect, userId: string) {
  const [existing] = await db.select().from(schema.financeEntries).where(and(eq(schema.financeEntries.source, 'event'), eq(schema.financeEntries.sourceRef, ev.id)));
  if (existing) return existing;
  if (t.financeLockedUntil && ev.startsAt.toISOString().slice(0, 10) <= t.financeLockedUntil) return null;
  return insertEntry(db, t, {
    kind: 'expense', entryDate: ev.startsAt.toISOString().slice(0, 10), amountMinor: ev.costMinor!,
    category: t.region === 'IN' ? 'Public meeting / rally' : 'Events', description: `${ev.title} (from events)`, partyName: 'See event bills',
    createdBy: userId, source: 'event', sourceRef: ev.id,
  });
}
