import '../../types.js';
import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { findOrCreateAccount } from '../../lib/accounts.js';
import { sendResetLink } from '../../routes/auth.js';
import { rateLimit } from '../../lib/rate-limit.js';
import { now, shortCode } from '../../lib/util.js';
import { loadTenant, requireRole, requireUser } from '../../middleware/auth.js';
import type { Deps } from '../../types.js';

const uuid = z.string().uuid();
const brand = z.object({
  brandName: z.string().min(2).max(80).nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #1F4E79').nullable().optional(),
  supportEmail: z.string().email().max(120).nullable().optional(),
});

const INVITE_DAYS = 7;
const normaliseCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (c: string) => createHash('sha256').update(normaliseCode(c)).digest('hex');
const days = (a: Date, b: Date) => Math.ceil((a.getTime() - b.getTime()) / 86_400_000);

/** Platform staff create an agency and name its first administrator. */
export function agencyAdminRoutes(deps: Deps) {
  const r = Router();
  const { pool, env } = deps;
  r.use(requireUser(deps));
  r.use((req, _res, next) => (req.user!.wes ? next() : next(new HttpError(403, 'FORBIDDEN'))));

  r.get('/agencies', ah(async (_req, res) => {
    res.json(await withTenant(pool, null, (db) => db.select().from(schema.agencies).orderBy(desc(schema.agencies.createdAt))));
  }));

  r.post('/agencies', ah(async (req, res) => {
    const b = brand.extend({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]{3,40}$/), adminEmail: z.string().email().max(254), adminName: z.string().max(120).optional(), adminPassword: z.string().max(256).optional() }).strict().parse(req.body);
    try {
      let invite: typeof schema.users.$inferSelect | null = null;
      const out = await withTenant(pool, null, async (db) => {
        const acct = await findOrCreateAccount(deps, db, { email: b.adminEmail, name: b.adminName, password: b.adminPassword });
        const u = acct.user;
        if (acct.invite) invite = u;
        const [a] = await db.insert(schema.agencies).values({ name: b.name, slug: b.slug, brandName: b.brandName ?? null, primaryColor: b.primaryColor ?? null, supportEmail: b.supportEmail ?? null, createdBy: req.user!.id }).returning();
        await db.insert(schema.agencyMembers).values({ agencyId: a!.id, userId: u.id, role: 'admin' });
        await db.insert(schema.auditLog).values({ actorId: req.user!.id, action: 'create_agency', entity: 'agency', entityId: a!.id, after: { name: a!.name, slug: a!.slug }, ip: req.ip });
        return a!;
      });
      if (invite) { try { await sendResetLink(deps, invite, 'invite'); } catch (e) { deps.log.error({ err: e }, 'could not send the invite email'); } }
      res.status(201).json(out);
    } catch (e: any) {
      if ((e?.cause ?? e)?.code === '23505') throw new HttpError(409, 'SLUG_TAKEN', 'That agency address is already in use.');
      throw e;
    }
  }));
  return r;
}

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

async function memberOf(pool: Deps['pool'], agencyId: string, userId: string) {
  const [m] = await withTenant(pool, null, (db) => db.select().from(schema.agencyMembers).where(and(eq(schema.agencyMembers.agencyId, agencyId), eq(schema.agencyMembers.userId, userId))));
  return m ?? null;
}

/** Totals for one campaign, for the agency overview. Counts and money only: nothing that identifies a person. */
export async function campaignTotals(db: Db, t: typeof schema.tenants.$inferSelect, at: Date) {
  const [c] = await db.select({ n: sql<number>`count(*)::int`, out: sql<number>`count(*) filter (where ${schema.contacts.optedOut})::int` }).from(schema.contacts);
  const runs = await db.select({ status: schema.campaignRuns.status, n: sql<number>`count(*)::int` }).from(schema.campaignRuns).groupBy(schema.campaignRuns.status);
  const weekAgo = new Date(at.getTime() - 7 * 86_400_000);
  const [calls] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.interactions).where(and(eq(schema.interactions.direction, 'outbound'), gt(schema.interactions.createdAt, weekAgo)));
  const [content] = await db.select({ drafts: sql<number>`count(*) filter (where ${schema.contentItems.status} = 'draft')::int`, ready: sql<number>`count(*) filter (where ${schema.contentItems.status} <> 'draft')::int` }).from(schema.contentItems);
  const [fin] = await db.select({
    spent: sql<number>`coalesce(sum(${schema.financeEntries.amountMinor}) filter (where ${schema.financeEntries.kind} = 'expense'), 0)::bigint`,
    flagged: sql<number>`count(*) filter (where jsonb_array_length(${schema.financeEntries.flags}) > 0)::int`,
  }).from(schema.financeEntries);
  const open = ['new', 'assigned', 'in_progress'] as const;
  const [tk] = await db.select({ open: sql<number>`count(*) filter (where ${inArray(schema.tickets.status, [...open])})::int`, overdue: sql<number>`count(*) filter (where ${inArray(schema.tickets.status, [...open])} and ${schema.tickets.dueAt} < ${at})::int` }).from(schema.tickets);
  const [doors] = await db.select({ n: sql<number>`count(distinct coalesce(${schema.doorVisits.contactId}::text, ${schema.doorVisits.household}))::int` }).from(schema.doorVisits);
  const spent = Number(fin?.spent ?? 0);
  return {
    contacts: c?.n ?? 0, optedOut: c?.out ?? 0,
    runs: Object.fromEntries(runs.map((x) => [x.status, x.n])), callsLast7Days: calls?.n ?? 0,
    content: { drafts: content?.drafts ?? 0, ready: content?.ready ?? 0 },
    spending: { currency: t.region === 'IN' ? 'INR' : 'CAD', spentMinor: spent, limitMinor: t.spendLimitMinor, share: t.spendLimitMinor ? spent / t.spendLimitMinor : null, flaggedEntries: fin?.flagged ?? 0 },
    service: { open: tk?.open ?? 0, overdue: tk?.overdue ?? 0 },
    doorsVisited: doors?.n ?? 0,
  };
}

/** Signed-in agency staff: their agencies, team, branding and the overview of linked campaigns. */
export function agencyRoutes(deps: Deps) {
  const r = Router();
  const { pool, env } = deps;

  /** 404 (not 403) for a non-member, so agency ids cannot be probed. */
  const asMember = (admin = false): RequestHandler => ah(async (req, _res, next) => {
    const id = uuid.safeParse(req.params.agencyId);
    const m = id.success ? await memberOf(pool, id.data, req.user!.id) : null;
    if (!m) throw new HttpError(404, 'AGENCY_NOT_FOUND');
    if (admin && m.role !== 'admin') throw new HttpError(403, 'AGENCY_ADMIN_ONLY', 'Only an agency administrator can do this.');
    (req as any).agencyRole = m.role;
    next();
  });

  r.get('/mine', ah(async (req, res) => {
    res.json(await withTenant(pool, null, (db) => db.select({ id: schema.agencies.id, name: schema.agencies.name, slug: schema.agencies.slug, brandName: schema.agencies.brandName, role: schema.agencyMembers.role })
      .from(schema.agencyMembers).innerJoin(schema.agencies, eq(schema.agencies.id, schema.agencyMembers.agencyId)).where(eq(schema.agencyMembers.userId, req.user!.id))));
  }));

  r.get('/:agencyId', asMember(), ah(async (req, res) => {
    const id = req.params.agencyId!;
    const out = await withTenant(pool, null, async (db) => {
      const [a] = await db.select().from(schema.agencies).where(eq(schema.agencies.id, id));
      const ms = await db.select({ m: schema.agencyMembers, u: schema.users }).from(schema.agencyMembers).innerJoin(schema.users, eq(schema.users.id, schema.agencyMembers.userId)).where(eq(schema.agencyMembers.agencyId, id));
      return { ...a!, role: (req as any).agencyRole as string, members: ms.map(({ m, u }) => ({ userId: u.id, name: u.name, email: u.email, role: m.role })) };
    });
    res.json(out);
  }));

  r.patch('/:agencyId', asMember(true), ah(async (req, res) => {
    const b = brand.extend({ name: z.string().min(2).max(120).optional() }).strict().parse(req.body);
    const [a] = await withTenant(pool, null, (db) => db.update(schema.agencies).set({
      ...(b.name && { name: b.name }), ...(b.brandName !== undefined && { brandName: b.brandName }), ...(b.primaryColor !== undefined && { primaryColor: b.primaryColor }), ...(b.supportEmail !== undefined && { supportEmail: b.supportEmail }),
    }).where(eq(schema.agencies.id, req.params.agencyId!)).returning());
    res.json(a);
  }));

  r.post('/:agencyId/members', asMember(true), ah(async (req, res) => {
    const b = z.object({ email: z.string().email().max(254), name: z.string().max(120).optional(), password: z.string().max(256).optional(), role: z.enum(['admin', 'staff']).default('staff') }).strict().parse(req.body);
    let invite: typeof schema.users.$inferSelect | null = null;
    const out = await withTenant(pool, null, async (db) => {
      const acct = await findOrCreateAccount(deps, db, { email: b.email, name: b.name, password: b.password });
      const u = acct.user;
      if (acct.invite) invite = u;
      const [m] = await db.insert(schema.agencyMembers).values({ agencyId: req.params.agencyId!, userId: u.id, role: b.role }).onConflictDoNothing().returning();
      if (!m) throw new HttpError(409, 'ALREADY_MEMBER');
      await db.insert(schema.auditLog).values({ actorId: req.user!.id, action: 'agency_add_member', entity: 'agency', entityId: req.params.agencyId!, after: { userId: u.id, role: b.role }, ip: req.ip });
      return { userId: u.id, name: u.name, email: u.email, role: b.role };
    });
    if (invite) { try { await sendResetLink(deps, invite, 'invite'); } catch (e) { deps.log.error({ err: e }, 'could not send the invite email'); } }
    res.status(201).json(out);
  }));

  r.delete('/:agencyId/members/:userId', asMember(true), ah(async (req, res) => {
    const uid = uuid.parse(req.params.userId);
    await withTenant(pool, null, async (db) => {
      const admins = await db.select().from(schema.agencyMembers).where(and(eq(schema.agencyMembers.agencyId, req.params.agencyId!), eq(schema.agencyMembers.role, 'admin')));
      if (admins.length === 1 && admins[0]!.userId === uid) throw new HttpError(409, 'LAST_ADMIN', 'An agency needs at least one administrator.');
      const gone = await db.delete(schema.agencyMembers).where(and(eq(schema.agencyMembers.agencyId, req.params.agencyId!), eq(schema.agencyMembers.userId, uid))).returning();
      if (!gone.length) throw new HttpError(404, 'NOT_FOUND');
    });
    res.json({ ok: true });
  }));

  /** Redeem the code a campaign owner gave you. Slowed down so codes cannot be guessed. */
  r.post('/:agencyId/link', rateLimit(deps.rateStore, 10, 60_000), asMember(true), ah(async (req, res) => {
    const b = z.object({ code: z.string().min(8).max(40) }).strict().parse(req.body);
    const { rows } = await pool.query('SELECT * FROM redeem_agency_invite($1, $2, $3)', [hashCode(b.code), req.params.agencyId, req.user!.id]);
    if (!rows[0]) throw new HttpError(422, 'INVITE_NOT_VALID', 'That code is not valid. It may have expired, been used already, or the campaign already has a white-label agency.');
    const tenantId = rows[0].tenant_id as string;
    await withTenant(pool, tenantId, (db) => db.insert(schema.auditLog).values({ tenantId, actorId: req.user!.id, action: 'agency_linked', entity: 'agency', entityId: req.params.agencyId!, ip: req.ip }));
    res.status(201).json({ linkId: rows[0].link_id, tenantId });
  }));

  /** Totals for every campaign linked to this agency, with what needs attention. */
  r.get('/:agencyId/overview', asMember(), ah(async (req, res) => {
    const at = now(deps);
    const { rows } = await pool.query('SELECT * FROM agency_linked_tenants($1, $2)', [req.params.agencyId, req.user!.id]);
    const campaigns = [];
    for (const l of rows as { link_id: string; tenant_id: string; white_label: boolean; linked_at: Date }[]) {
      const row = await withTenant(pool, l.tenant_id, async (db) => {
        const [t] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, l.tenant_id));
        if (!t) return null;
        const totals = await campaignTotals(db, t, at);
        const attention: string[] = [];
        if (totals.spending.share != null && totals.spending.share >= 0.9) attention.push('SPENDING_NEAR_LIMIT');
        if (totals.spending.flaggedEntries) attention.push('FLAGGED_ENTRIES');
        if (totals.content.drafts) attention.push('CONTENT_AWAITING_APPROVAL');
        if (totals.runs.blocked) attention.push('BLOCKED_CALL_RUNS');
        if (totals.service.overdue) attention.push('OVERDUE_REQUESTS');
        if (t.kind === 'campaign' && !t.retentionDays) attention.push('RETENTION_NOT_SET');
        return {
          linkId: l.link_id, tenantId: t.id, campaignName: t.campaignName, candidateName: t.candidateName, region: t.region, kind: t.kind, seatCode: t.seatCode, isDemo: t.isDemo, status: t.status,
          electionDate: t.electionDate, daysToElection: t.kind === 'campaign' ? days(new Date(`${t.electionDate}T00:00:00Z`), at) : null, whiteLabel: l.white_label, linkedAt: l.linked_at, ...totals, attention,
        };
      });
      if (row) campaigns.push(row);
    }
    campaigns.sort((a, b) => (a.daysToElection ?? 1e9) - (b.daysToElection ?? 1e9));
    res.json({ campaigns, attention: campaigns.reduce((s, c) => s + c.attention.length, 0) });
  }));

  return r;
}

/** A campaign owner's side: invite an agency, see who is linked, switch white-label, revoke. */
export function tenantAgencyRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool } = deps;
  r.use(loadTenant(deps));

  /** The agency brand to show in this campaign's dashboard, if one is white-label linked. Any team member may read it. */
  r.get('/branding', ah(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM tenant_branding($1)', [req.tenant!.id]);
    const b = rows[0];
    res.json({ agency: b ? { id: b.agency_id, name: b.name, brandName: b.brand_name ?? b.name, primaryColor: b.primary_color, supportEmail: b.support_email } : null });
  }));

  r.get('/', requireRole('owner'), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, async (db) => {
      const links = await db.select({ l: schema.agencyLinks, name: schema.agencies.name }).from(schema.agencyLinks).innerJoin(schema.agencies, eq(schema.agencies.id, schema.agencyLinks.agencyId)).orderBy(desc(schema.agencyLinks.createdAt));
      const invites = await db.select({ id: schema.agencyInvites.id, whiteLabel: schema.agencyInvites.whiteLabel, expiresAt: schema.agencyInvites.expiresAt, createdAt: schema.agencyInvites.createdAt })
        .from(schema.agencyInvites).where(and(isNull(schema.agencyInvites.usedAt), gt(schema.agencyInvites.expiresAt, now(deps))));
      return { links: links.map(({ l, name }) => ({ id: l.id, agency: name, status: l.status, whiteLabel: l.whiteLabel, linkedAt: l.createdAt, revokedAt: l.revokedAt })), openInvites: invites };
    }));
  }));

  /** A one-time code for an agency. It is shown once and expires in a week. Anyone who holds it can link their agency, so hand it over privately. */
  r.post('/invite', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ whiteLabel: z.boolean().default(false) }).strict().parse(req.body ?? {});
    const raw = shortCode(10).toUpperCase();
    const code = `AG-${raw.slice(0, 5)}-${raw.slice(5)}`;
    const expiresAt = new Date(now(deps).getTime() + INVITE_DAYS * 86_400_000);
    await withTenant(pool, t.id, async (db) => {
      await db.insert(schema.agencyInvites).values({ tenantId: t.id, codeHash: hashCode(code), whiteLabel: b.whiteLabel, createdBy: req.user!.id, expiresAt });
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'agency_invite', entity: 'tenant', entityId: t.id, after: { whiteLabel: b.whiteLabel }, ip: req.ip });
    });
    res.status(201).json({ code, expiresAt, whiteLabel: b.whiteLabel });
  }));

  r.patch('/:linkId', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    const b = z.object({ whiteLabel: z.boolean() }).strict().parse(req.body);
    try {
      const out = await withTenant(pool, t.id, async (db) => {
        const [l] = await db.update(schema.agencyLinks).set({ whiteLabel: b.whiteLabel }).where(and(eq(schema.agencyLinks.id, uuid.parse(req.params.linkId)), eq(schema.agencyLinks.status, 'active'))).returning();
        if (!l) throw new HttpError(404, 'NOT_FOUND');
        await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'agency_white_label', entity: 'agency_link', entityId: l.id, after: b, ip: req.ip });
        return l;
      });
      res.json(out);
    } catch (e: any) {
      if ((e?.cause ?? e)?.code === '23505') throw new HttpError(409, 'ONE_WHITE_LABEL_AGENCY', 'Only one agency can be white-label for a campaign at a time.');
      throw e;
    }
  }));

  r.post('/:linkId/revoke', requireRole('owner'), ah(async (req, res) => {
    const t = req.tenant!;
    const out = await withTenant(pool, t.id, async (db) => {
      const [l] = await db.update(schema.agencyLinks).set({ status: 'revoked', whiteLabel: false, revokedAt: now(deps) }).where(and(eq(schema.agencyLinks.id, uuid.parse(req.params.linkId)), eq(schema.agencyLinks.status, 'active'))).returning();
      if (!l) throw new HttpError(404, 'NOT_FOUND');
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'agency_revoked', entity: 'agency_link', entityId: l.id, ip: req.ip });
      return l;
    });
    res.json(out);
  }));

  return r;
}
