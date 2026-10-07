import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { contributionFlags, csvCell, expenseFlags, normaliseParty } from './rules.js';
import { filingFormat, filingFormatsFor, getProvince } from '@cs/regions';
import writeExcelFile from 'write-excel-file/node';
import { BANK_MODES, matchLines, parseBankCsv, type EntryLite } from './reconcile.js';
import { renderFiling } from './filing.js';
import { deleteFiles, loadFile, saveFile } from '../files/files.js';
import { rawUpload, sendBlob, uploadName } from '../files/routes.js';
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
        categories: getProvince(t.region, t.province)?.expenseCategories ?? (t.region === 'IN' ? IN_CATEGORIES : CA_CATEGORIES),
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
      // Not a block: the agent may sign off with open items, but is told what the bank statements disagree on.
      return { ...s!, reconciliation: await reconciliation(db) };
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
    const fmt = filingFormat(String(req.query.format ?? (kind === 'expense' ? 'register-expense' : 'register-contribution')), t.region, kind, t.province);
    if (!fmt) throw new HttpError(422, 'FORMAT_NOT_AVAILABLE', 'That layout is not available for this campaign. See /finance/formats.');
    const table = renderFiling(fmt, rows.list);
    const note = `# ${t.campaignName} — ${fmt.title}, ${kind} entries up to ${rows.s.periodTo}, signed off ${rows.s.signedAt.toISOString()}. Check the column layout against the form your election authority requires.`;
    const draft = fmt.confirmed ? null : `# DRAFT LAYOUT: not yet checked against the official form of ${fmt.authority}. Compare it with their form before filing.`;
    const base = `${kind}-${fmt.id}-${rows.s.periodTo}`;
    if (req.query.as === 'xlsx') {
      const cells = (v: string | number | null) => ({ value: v == null ? '' : v });
      const sheet = [[cells(note)], ...(draft ? [[cells(draft)]] : []), table.head.map((h) => ({ value: h, fontWeight: 'bold' as const })), ...table.rows.map((r) => r.map(cells))];
      const buf = await writeExcelFile(sheet as never).toBuffer();
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
      return res.send(buf);
    }
    res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    res.send([note, ...(draft ? [draft] : []), table.head.map(csvCell).join(','), ...table.rows.map((r) => r.map(csvCell).join(','))].join('\n'));
  }));

  /** The layouts this campaign can export its registers in, and whether each has been checked against the official form. */
  r.get('/formats', requireRole(...SIGNERS), (req, res) => {
    const t = req.tenant!;
    const pick = (kind: 'expense' | 'contribution') => filingFormatsFor(t.region, kind, t.province).map((f) => ({ id: f.id, title: f.title, authority: f.authority, confirmed: f.confirmed, default: f.id.startsWith('register-') }));
    res.json({ expense: pick('expense'), contribution: pick('contribution') });
  });

  // ----- receipt photos -----
  /** Attaches a receipt (photo or PDF) to an entry. The request body is the file itself. Replaces an earlier one. */
  r.post('/entries/:id/receipt', requireRole(...WRITERS), rawUpload(9 * 1024 * 1024), ah(async (req, res) => {
    const t = req.tenant!;
    const id = z.string().uuid().parse(req.params.id);
    const out = await withTenant(pool, t.id, async (db) => {
      const [e] = await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.id, id));
      if (!e) throw new HttpError(404, 'NOT_FOUND');
      if (t.financeLockedUntil && e.entryDate <= t.financeLockedUntil) throw new HttpError(423, 'PERIOD_LOCKED', `Entries up to ${t.financeLockedUntil} are locked.`);
      const f = await saveFile(deps, db, t.id, req.user!.id, 'receipt', Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), uploadName(req));
      await db.update(schema.financeEntries).set({ receiptFileId: f.id, updatedAt: new Date() }).where(eq(schema.financeEntries.id, id));
      if (e.receiptFileId) await deleteFiles(deps, db, eq(schema.storedFiles.id, e.receiptFileId));
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'attach_receipt', entity: 'finance_entry', entityId: id, after: { fileId: f.id, sha256: f.sha256, bytes: f.bytes }, ip: req.ip });
      return { fileId: f.id, contentType: f.contentType, bytes: f.bytes, sha256: f.sha256 };
    });
    res.status(201).json(out);
  }));

  r.get('/entries/:id/receipt', ah(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { file, body } = await withTenant(pool, req.tenant!.id, async (db) => {
      const [e] = await db.select({ f: schema.financeEntries.receiptFileId }).from(schema.financeEntries).where(eq(schema.financeEntries.id, id));
      if (!e?.f) throw new HttpError(404, 'NO_RECEIPT');
      return loadFile(deps, db, e.f, 'receipt');
    });
    sendBlob(res, body, file.contentType, file.originalName);
  }));

  // ----- bank statement reconciliation -----
  /** Uploads a bank statement (CSV, the request body) and pairs its lines with the register. */
  r.post('/bank-statements', requireRole('owner', 'finance_agent'), rawUpload(6 * 1024 * 1024), ah(async (req, res) => {
    const t = req.tenant!;
    const label = z.string().min(1).max(120).default('Bank statement').parse(req.query.label || undefined);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await withTenant(pool, t.id, async (db) => {
      const f = await saveFile(deps, db, t.id, req.user!.id, 'bank_statement', buf, uploadName(req));
      const parsed = parseBankCsv(buf.toString('utf8'), t.region === 'IN' ? 'dmy' : 'mdy');
      if (!parsed.lines.length) throw new HttpError(422, 'STATEMENT_NOT_READABLE', `No transactions could be read (${parsed.skipped[0]?.reason ?? 'empty'}). Export the statement as CSV with a Date column and Debit/Credit or Amount columns.`);
      const [st] = await db.insert(schema.bankStatements).values({ tenantId: t.id, fileId: f.id, label, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, lineCount: parsed.lines.length, uploadedBy: req.user!.id }).returning();
      const rows = await db.insert(schema.bankLines).values(parsed.lines.map((l) => ({
        tenantId: t.id, statementId: st!.id, lineNo: l.lineNo, lineDate: l.date, description: l.description, reference: l.reference, direction: l.direction, amountMinor: l.amountMinor,
      }))).returning();
      const entries = await unmatchedEntries(db);
      const m = matchLines(rows.map((l) => ({ id: l.id, date: l.lineDate, direction: l.direction, amountMinor: l.amountMinor, description: l.description, reference: l.reference })), entries);
      let matched = 0, suggested = 0;
      for (const l of rows) {
        const x = m.get(l.id)!;
        if (x.status === 'unmatched') continue;
        if (x.status === 'matched') matched++; else suggested++;
        await db.update(schema.bankLines).set({ matchStatus: x.status, matchedEntryId: x.status === 'matched' ? x.entryId : null, matchedAt: x.status === 'matched' ? new Date() : null }).where(eq(schema.bankLines.id, l.id));
      }
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'upload_bank_statement', entity: 'bank_statement', entityId: st!.id, after: { lines: rows.length, matched, suggested, sha256: f.sha256 }, ip: req.ip });
      return { id: st!.id, label, periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, lines: rows.length, matched, suggested, unmatched: rows.length - matched - suggested, skipped: parsed.skipped };
    });
    res.status(201).json(out);
  }));

  r.get('/bank-statements', ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, async (db) => {
      const sts = await db.select().from(schema.bankStatements).orderBy(desc(schema.bankStatements.createdAt));
      const counts = await db.select({ s: schema.bankLines.statementId, status: schema.bankLines.matchStatus, n: sql<number>`count(*)::int` }).from(schema.bankLines).groupBy(schema.bankLines.statementId, schema.bankLines.matchStatus);
      return sts.map((s) => ({ ...s, counts: Object.fromEntries(counts.filter((c) => c.s === s.id).map((c) => [c.status, c.n])) }));
    }));
  }));

  /** The lines of one statement, each with the entry it is matched to, or the entries it might be. */
  r.get('/bank-statements/:id', ah(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await withTenant(pool, req.tenant!.id, async (db) => {
      const [st] = await db.select().from(schema.bankStatements).where(eq(schema.bankStatements.id, id));
      if (!st) throw new HttpError(404, 'NOT_FOUND');
      const lines = await db.select().from(schema.bankLines).where(eq(schema.bankLines.statementId, id)).orderBy(asc(schema.bankLines.lineNo));
      const free = await unmatchedEntries(db);
      const used = lines.map((l) => l.matchedEntryId).filter((x): x is string => Boolean(x));
      const matchedEntries = used.length ? await db.select().from(schema.financeEntries).where(inArray(schema.financeEntries.id, used)) : [];
      const sugg = matchLines(lines.filter((l) => l.matchStatus !== 'matched' && l.matchStatus !== 'ignored').map((l) => ({ id: l.id, date: l.lineDate, direction: l.direction, amountMinor: l.amountMinor, description: l.description, reference: l.reference })), free);
      const slim = (e: typeof matchedEntries[number]) => ({ id: e.id, entryDate: e.entryDate, kind: e.kind, amountMinor: e.amountMinor, partyName: e.partyName, description: e.description });
      return {
        statement: st,
        lines: lines.map((l) => ({
          ...l,
          entry: l.matchedEntryId ? slim(matchedEntries.find((e) => e.id === l.matchedEntryId)!) : null,
          candidates: l.matchStatus === 'matched' || l.matchStatus === 'ignored' ? [] : (sugg.get(l.id)?.candidates ?? []).map((cid) => free.find((e) => e.id === cid)!).filter(Boolean),
        })),
      };
    }));
  }));

  r.post('/bank-lines/:lineId/match', requireRole('owner', 'finance_agent'), ah(async (req, res) => {
    const t = req.tenant!;
    const lineId = z.string().uuid().parse(req.params.lineId);
    const b = z.object({ entryId: z.string().uuid(), note: z.string().min(3).max(300).optional() }).strict().parse(req.body);
    const out = await withTenant(pool, t.id, async (db) => {
      const [l] = await db.select().from(schema.bankLines).where(eq(schema.bankLines.id, lineId));
      const [e] = await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.id, b.entryId));
      if (!l || !e) throw new HttpError(404, 'NOT_FOUND');
      if (e.kind !== (l.direction === 'debit' ? 'expense' : 'contribution')) throw new HttpError(422, 'WRONG_DIRECTION', 'Money out matches an expense; money in matches a contribution.');
      if (e.amountMinor !== l.amountMinor && !b.note) throw new HttpError(422, 'AMOUNT_DIFFERS', 'The amounts differ. Add a note saying why (for example a bank charge), then match.');
      const [taken] = await db.select({ id: schema.bankLines.id }).from(schema.bankLines).where(and(eq(schema.bankLines.matchedEntryId, e.id), ne(schema.bankLines.id, l.id)));
      if (taken) throw new HttpError(409, 'ENTRY_ALREADY_MATCHED', 'This entry is already matched to another bank line.');
      const [u] = await db.update(schema.bankLines).set({ matchStatus: 'matched', matchedEntryId: e.id, matchNote: b.note ?? null, matchedBy: req.user!.id, matchedAt: new Date() }).where(eq(schema.bankLines.id, l.id)).returning();
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'bank_match', entity: 'bank_line', entityId: l.id, after: { entryId: e.id, note: b.note ?? null }, ip: req.ip });
      return u!;
    });
    res.json(out);
  }));

  r.post('/bank-lines/:lineId/unmatch', requireRole('owner', 'finance_agent'), ah(async (req, res) => {
    const t = req.tenant!;
    const lineId = z.string().uuid().parse(req.params.lineId);
    const out = await withTenant(pool, t.id, async (db) => {
      const [u] = await db.update(schema.bankLines).set({ matchStatus: 'unmatched', matchedEntryId: null, matchNote: null, matchedBy: null, matchedAt: null }).where(eq(schema.bankLines.id, lineId)).returning();
      if (!u) throw new HttpError(404, 'NOT_FOUND');
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'bank_unmatch', entity: 'bank_line', entityId: lineId, ip: req.ip });
      return u;
    });
    res.json(out);
  }));

  /** Marks a line as not belonging in the register (for example the bank's own fee or a transfer between the campaign's accounts). Needs a reason. */
  r.post('/bank-lines/:lineId/ignore', requireRole('owner', 'finance_agent'), ah(async (req, res) => {
    const t = req.tenant!;
    const lineId = z.string().uuid().parse(req.params.lineId);
    const b = z.object({ note: z.string().min(3).max(300) }).strict().parse(req.body);
    const out = await withTenant(pool, t.id, async (db) => {
      const [u] = await db.update(schema.bankLines).set({ matchStatus: 'ignored', matchedEntryId: null, matchNote: b.note, matchedBy: req.user!.id, matchedAt: new Date() }).where(eq(schema.bankLines.id, lineId)).returning();
      if (!u) throw new HttpError(404, 'NOT_FOUND');
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'bank_ignore', entity: 'bank_line', entityId: lineId, after: { note: b.note }, ip: req.ip });
      return u;
    });
    res.json(out);
  }));

  /** What does not agree: money the bank shows that has no entry, and bank-paid entries the statements do not show. */
  r.get('/reconciliation', ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => reconciliation(db)));
  }));

  return r;
}

type EntryRow = typeof schema.financeEntries.$inferSelect;

/** Entries a bank line could still be matched to: not already matched, and paid in a way that passes through a bank. */
async function unmatchedEntries(db: Db): Promise<EntryLite[]> {
  const used = await db.select({ id: schema.bankLines.matchedEntryId }).from(schema.bankLines).where(sql`${schema.bankLines.matchedEntryId} is not null`);
  const taken = new Set(used.map((u) => u.id));
  const all = await db.select().from(schema.financeEntries);
  return all.filter((e) => !taken.has(e.id)).map((e) => ({ id: e.id, kind: e.kind, entryDate: e.entryDate, amountMinor: e.amountMinor, partyName: e.partyName, paymentMode: e.paymentMode, billNo: e.billNo }));
}

export async function reconciliation(db: Db) {
  const sts = await db.select().from(schema.bankStatements);
  const from = sts.map((s) => s.periodFrom).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  const to = sts.map((s) => s.periodTo).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const open = await db.select().from(schema.bankLines).where(inArray(schema.bankLines.matchStatus, ['unmatched', 'suggested'])).orderBy(asc(schema.bankLines.lineDate));
  let notOnStatement: EntryRow[] = [];
  if (from && to) {
    const taken = await db.select({ id: schema.bankLines.matchedEntryId }).from(schema.bankLines).where(sql`${schema.bankLines.matchedEntryId} is not null`);
    const takenIds = new Set(taken.map((x) => x.id));
    const inRange = await db.select().from(schema.financeEntries).where(and(gte(schema.financeEntries.entryDate, from), lte(schema.financeEntries.entryDate, to)));
    notOnStatement = inRange.filter((e) => e.paymentMode != null && BANK_MODES.has(e.paymentMode) && !takenIds.has(e.id));
  }
  const sum = (xs: { amountMinor: number }[]) => xs.reduce((s, x) => s + Number(x.amountMinor), 0);
  return {
    period: { from, to },
    statements: sts.length,
    inBankNotInRegister: open.map((l) => ({ id: l.id, statementId: l.statementId, date: l.lineDate, direction: l.direction, amountMinor: l.amountMinor, description: l.description, status: l.matchStatus })),
    inRegisterNotInBank: notOnStatement.map((e) => ({ id: e.id, date: e.entryDate, kind: e.kind, amountMinor: e.amountMinor, partyName: e.partyName, paymentMode: e.paymentMode })),
    totals: { bankLinesOpen: open.length, bankAmountOpenMinor: sum(open), entriesNotOnStatement: notOnStatement.length, entriesAmountMinor: sum(notOnStatement) },
    clean: open.length === 0 && notOnStatement.length === 0 && sts.length > 0,
  };
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
