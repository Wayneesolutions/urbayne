import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, withTenant, VISIT_RESULTS } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { decrypt } from '../../lib/crypto.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import type { Deps } from '../../types.js';

const MANAGERS = ['owner', 'manager', 'coordinator'] as const;

export function fieldRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool, env } = deps;
  r.use(loadTenant(deps));

  // ----- managers -----
  r.get('/turfs', requireRole(...MANAGERS), ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, async (db) => {
      const turfs = await db.select({ t: schema.turfs, area: schema.geoAreas.nameEn, worker: schema.users.name })
        .from(schema.turfs).innerJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.turfs.geoAreaId))
        .leftJoin(schema.users, eq(schema.users.id, schema.turfs.assignedUserId)).orderBy(schema.turfs.name);
      const households = await db.select({ area: schema.contacts.geoAreaId, n: sql<number>`count(*)::int` }).from(schema.contacts).groupBy(schema.contacts.geoAreaId);
      const visited = await db.select({ turf: schema.doorVisits.turfId, n: sql<number>`count(distinct coalesce(${schema.doorVisits.contactId}::text, ${schema.doorVisits.household}))::int` })
        .from(schema.doorVisits).groupBy(schema.doorVisits.turfId);
      return turfs.map(({ t, area, worker }) => ({
        ...t, area, worker,
        households: households.find((h) => h.area === t.geoAreaId)?.n ?? 0,
        visited: visited.find((v) => v.turf === t.id)?.n ?? 0,
      }));
    });
    res.json(rows);
  }));

  r.post('/turfs', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({ geoAreaId: z.string().uuid(), name: z.string().min(1).max(80), assignedUserId: z.string().uuid().nullable().optional() }).parse(req.body);
    const t = req.tenant!;
    const row = await withTenant(pool, t.id, async (db) => {
      if (b.assignedUserId) await assertWorker(db, t.id, b.assignedUserId);
      const [x] = await db.insert(schema.turfs).values({ tenantId: t.id, ...b }).returning();
      return x;
    });
    res.status(201).json(row);
  }));

  r.patch('/turfs/:turfId', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = z.object({ assignedUserId: z.string().uuid().nullable().optional(), status: z.enum(['active', 'done']).optional() }).parse(req.body);
    const t = req.tenant!;
    const [row] = await withTenant(pool, t.id, async (db) => {
      if (b.assignedUserId) await assertWorker(db, t.id, b.assignedUserId);
      return db.update(schema.turfs).set({ ...b, updatedAt: new Date() }).where(eq(schema.turfs.id, req.params.turfId!)).returning();
    });
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    res.json(row);
  }));

  /** Latest result per household, rolled up by area. */
  r.get('/summary', requireRole(...MANAGERS), ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, (db) => db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (coalesce(v.contact_id::text, v.household)) v.result, t.geo_area_id
        FROM door_visits v JOIN turfs t ON t.id = v.turf_id
        ORDER BY coalesce(v.contact_id::text, v.household), v.visited_at DESC
      )
      SELECT g.name_en AS area, l.result, count(*)::int AS n
      FROM latest l JOIN geo_areas g ON g.id = l.geo_area_id
      GROUP BY g.name_en, l.result ORDER BY g.name_en`));
    const byArea: Record<string, Record<string, number>> = {};
    for (const x of rows.rows as { area: string; result: string; n: number }[]) (byArea[x.area] ??= {})[x.result] = x.n;
    res.json(Object.entries(byArea).map(([area, counts]) => ({ area, counts })));
  }));

  // ----- workers -----
  r.get('/my-turfs', ah(async (req, res) => {
    const t = req.tenant!;
    const out = await withTenant(pool, t.id, async (db) => {
      const turfs = await db.select({ t: schema.turfs, area: schema.geoAreas }).from(schema.turfs)
        .innerJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.turfs.geoAreaId))
        .where(and(eq(schema.turfs.assignedUserId, req.user!.id), eq(schema.turfs.status, 'active')));
      if (!turfs.length) return [];
      const areaIds = turfs.map((x) => x.t.geoAreaId);
      const people = await db.select().from(schema.contacts).where(inArray(schema.contacts.geoAreaId, areaIds)).orderBy(schema.contacts.name);
      const visits = await db.select().from(schema.doorVisits).where(inArray(schema.doorVisits.turfId, turfs.map((x) => x.t.id))).orderBy(desc(schema.doorVisits.visitedAt));
      return turfs.map(({ t: turf, area }) => ({
        id: turf.id, name: turf.name, area: { nameEn: area.nameEn, namePa: area.namePa, nameHi: area.nameHi },
        households: people.filter((p) => p.geoAreaId === turf.geoAreaId).map((p) => ({
          contactId: p.id, name: p.name,
          // Workers see only the last 4 digits: enough to confirm the right house, not enough to copy a list.
          phoneEnd: decrypt(p.phoneEnc, env.PHONE_ENC_KEY).slice(-4),
          lastResult: visits.find((v) => v.contactId === p.id)?.result ?? null,
        })),
        extraDoors: [...new Set(visits.filter((v) => v.turfId === turf.id && v.household).map((v) => v.household!))],
      }));
    });
    res.json(out);
  }));

  r.post('/visits/batch', ah(async (req, res) => {
    const b = z.object({ visits: z.array(z.object({
      clientUuid: z.string().uuid(), turfId: z.string().uuid(), contactId: z.string().uuid().optional(), household: z.string().max(200).optional(),
      result: z.enum(VISIT_RESULTS), note: z.string().max(500).optional(), visitedAt: z.string().datetime({ offset: true }),
    })).max(500) }).parse(req.body);
    const t = req.tenant!;
    const isManager = (MANAGERS as readonly string[]).includes(req.role!);
    const out = await withTenant(pool, t.id, async (db) => {
      const turfIds = [...new Set(b.visits.map((v) => v.turfId))];
      const turfs = turfIds.length ? await db.select().from(schema.turfs).where(inArray(schema.turfs.id, turfIds)) : [];
      let accepted = 0, duplicates = 0;
      const rejected: string[] = [];
      for (const v of b.visits) {
        const turf = turfs.find((x) => x.id === v.turfId);
        if (!turf || (!isManager && turf.assignedUserId !== req.user!.id) || (!v.contactId && !v.household)) { rejected.push(v.clientUuid); continue; }
        const [row] = await db.insert(schema.doorVisits).values({
          tenantId: t.id, turfId: v.turfId, contactId: v.contactId, household: v.household, result: v.result, note: v.note,
          workerId: req.user!.id, visitedAt: new Date(v.visitedAt), clientUuid: v.clientUuid,
        }).onConflictDoNothing().returning();
        if (!row) { duplicates++; continue; }
        accepted++;
        if (v.result === 'wants_sign' && t.region === 'CA') {
          await db.insert(schema.signs).values({ tenantId: t.id, contactId: v.contactId, address: v.household ?? `Contact ${v.contactId}` });
        }
      }
      return { accepted, duplicates, rejected };
    });
    res.json(out);
  }));

  return r;
}

async function assertWorker(db: Parameters<Parameters<typeof withTenant>[2]>[0], tenantId: string, userId: string) {
  const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, userId)));
  if (!m) throw new HttpError(422, 'NOT_A_MEMBER', 'Add this person to the team first.');
}
