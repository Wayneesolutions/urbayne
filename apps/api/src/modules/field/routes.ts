import '../../types.js';
import express, { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, withTenant, VISIT_RESULTS } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { decrypt } from '../../lib/crypto.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { saveFile, sniff } from '../files/files.js';
import { rawUpload, uploadName } from '../files/routes.js';
import { MAX_ROLL_ROWS, householdLabel, normHouseNo, parseRollRows, readTable, saveHouseholds, type RollHousehold, type RollParse } from './roll.js';
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
      const fromContacts = await db.select({ area: schema.contacts.geoAreaId, n: sql<number>`count(*)::int` }).from(schema.contacts).groupBy(schema.contacts.geoAreaId);
      const fromRolls = await db.select({ area: schema.households.geoAreaId, n: sql<number>`count(*)::int` }).from(schema.households).groupBy(schema.households.geoAreaId);
      const households = [...fromContacts, ...fromRolls.map((x) => ({ area: x.area as string | null, n: x.n }))];
      const visited = await db.select({ turf: schema.doorVisits.turfId, n: sql<number>`count(distinct coalesce(${schema.doorVisits.contactId}::text, ${schema.doorVisits.household}))::int` })
        .from(schema.doorVisits).groupBy(schema.doorVisits.turfId);
      return turfs.map(({ t, area, worker }) => ({
        ...t, area, worker,
        households: households.filter((h) => h.area === t.geoAreaId).reduce((s, h) => s + h.n, 0),
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

  // ----- household import from electoral roll copies -----
  /** Uploads the roll copy as proof of where a list came from (PDF, Excel, CSV or a photo). The request body is the file. */
  r.post('/roll-proofs', requireRole(...MANAGERS), rawUpload(26 * 1024 * 1024), ah(async (req, res) => {
    const t = req.tenant!;
    const f = await withTenant(pool, t.id, (db) => saveFile(deps, db, t.id, req.user!.id, 'roll_proof', Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), uploadName(req)));
    res.status(201).json({ fileId: f.id, contentType: f.contentType, bytes: f.bytes, sha256: f.sha256 });
  }));

  const importMeta = z.object({
    areaId: z.string().uuid(),
    sourceKind: z.enum(['electoral_roll_copy', 'other_legal_list']).default('electoral_roll_copy'),
    /** Who gave the list, when, and under what entitlement. A returning officer will ask. */
    sourceDescription: z.string().min(10).max(500),
    proofFileId: z.string().uuid().optional(),
  });

  /** Common tail of both import routes: checks the area and the proof, writes the import and its households, audits it. */
  async function runImport(req: express.Request, meta: z.infer<typeof importMeta>, format: 'csv' | 'xlsx' | 'rows', parsed: RollParse, ownProof: { id: string } | null) {
    const t = req.tenant!;
    if (parsed.households.length > MAX_ROLL_ROWS) throw new HttpError(413, 'ROLL_TOO_LARGE', `At most ${MAX_ROLL_ROWS} households per upload. Split the file by booth.`);
    return withTenant(pool, t.id, async (db) => {
      const [area] = await db.select().from(schema.geoAreas).where(eq(schema.geoAreas.id, meta.areaId));
      if (!area) throw new HttpError(404, 'AREA_NOT_FOUND');
      const proofId = meta.proofFileId ?? ownProof?.id;
      if (!proofId) throw new HttpError(422, 'SOURCE_PROOF_REQUIRED', 'Upload the roll copy as proof of where this list came from.');
      const [proof] = await db.select().from(schema.storedFiles).where(and(eq(schema.storedFiles.id, proofId), eq(schema.storedFiles.purpose, 'roll_proof')));
      if (!proof) throw new HttpError(422, 'SOURCE_PROOF_REQUIRED', 'The proof file was not found. Upload it again.');
      const [imp] = await db.insert(schema.rollImports).values({
        tenantId: t.id, geoAreaId: area.id, proofFileId: proof.id, sourceKind: meta.sourceKind, sourceDescription: meta.sourceDescription, format,
        rowsTotal: parsed.total, rowsImported: 0, rowsRejected: parsed.rejected, ignoredColumns: parsed.ignoredColumns, importedBy: req.user!.id,
      }).returning();
      const saved = await saveHouseholds(db, t.id, area.id, imp!.id, parsed.households);
      await db.execute(sql`UPDATE roll_imports SET rows_imported = ${saved.imported}, rows_duplicate = ${saved.existing} WHERE id = ${imp!.id}`);
      await db.insert(schema.auditLog).values({ tenantId: t.id, actorId: req.user!.id, action: 'roll_import', entity: 'roll_import', entityId: imp!.id, after: { areaId: area.id, format, households: saved.imported, existing: saved.existing, rejected: parsed.rejected, proofSha256: proof.sha256 }, ip: req.ip });
      return { id: imp!.id, areaId: area.id, rowsTotal: parsed.total, households: saved.imported, alreadyOnFile: saved.existing, rejected: parsed.rejected, ignoredColumns: parsed.ignoredColumns, proofFileId: proof.id };
    });
  }

  /** An Excel or CSV roll copy (the request body). With no separate proof, the file itself is kept as the proof. */
  r.post('/roll-imports/spreadsheet', requireRole(...MANAGERS), rawUpload(26 * 1024 * 1024), ah(async (req, res) => {
    const t = req.tenant!;
    const meta = importMeta.parse({ areaId: req.query.areaId, sourceKind: req.query.sourceKind || undefined, sourceDescription: req.query.sourceDescription, proofFileId: req.query.proofFileId || undefined });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const kind = sniff(buf);
    if (!kind) throw new HttpError(415, 'ROLL_FORMAT', 'Upload an Excel (.xlsx) or CSV file.');
    const table = await readTable(buf, kind.type);
    const parsed = parseRollRows(table);
    let own: { id: string } | null = null;
    if (!meta.proofFileId) own = await withTenant(pool, t.id, (db) => saveFile(deps, db, t.id, req.user!.id, 'roll_proof', buf, uploadName(req)));
    res.status(201).json(await runImport(req, meta, kind.type === 'text/csv' ? 'csv' : 'xlsx', parsed, own));
  }));

  /** Households typed in or extracted elsewhere (for example from a PDF roll), with the PDF uploaded first as proof. */
  r.post('/roll-imports', requireRole(...MANAGERS), ah(async (req, res) => {
    const b = importMeta.extend({ proofFileId: z.string().uuid(), rows: z.array(z.object({ houseNo: z.string().min(1).max(40), address: z.string().max(200).optional(), electors: z.number().int().min(0).max(500).optional() }).strict()).min(1).max(MAX_ROLL_ROWS) }).strict().parse(req.body);
    const seen = new Map<string, RollHousehold>();
    let dup = 0;
    for (const x of b.rows) {
      const no = normHouseNo(x.houseNo);
      if (!no) continue;
      if (seen.has(no)) { dup++; continue; }
      seen.set(no, { houseNo: no, address: x.address?.trim() || null, electors: x.electors ?? null });
    }
    const { rows: _r, ...meta } = b;
    res.status(201).json(await runImport(req, meta, 'rows', { households: [...seen.values()], total: b.rows.length, rejected: b.rows.length - seen.size - dup, duplicateRows: dup, ignoredColumns: [] }, null));
  }));

  r.get('/roll-imports', requireRole(...MANAGERS), ah(async (req, res) => {
    res.json(await withTenant(pool, req.tenant!.id, (db) => db.select({ i: schema.rollImports, area: schema.geoAreas.nameEn }).from(schema.rollImports)
      .innerJoin(schema.geoAreas, eq(schema.geoAreas.id, schema.rollImports.geoAreaId)).orderBy(desc(schema.rollImports.createdAt))
      .then((rows) => rows.map(({ i, area }) => ({ ...i, area })))));
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
      // Houses from imported roll copies: shown as doors to knock on, with no names or phone numbers.
      const rolls = await db.select().from(schema.households).where(inArray(schema.households.geoAreaId, areaIds)).orderBy(schema.households.houseNo);
      return turfs.map(({ t: turf, area }) => {
        const rollDoors = rolls.filter((h) => h.geoAreaId === turf.geoAreaId).map((h) => {
          const label = householdLabel(h);
          return { household: label, name: label, electors: h.electors, lastResult: visits.find((v) => v.turfId === turf.id && v.household === label)?.result ?? null };
        });
        const rollLabels = new Set(rollDoors.map((d) => d.household));
        return {
          id: turf.id, name: turf.name, area: { nameEn: area.nameEn, namePa: area.namePa, nameHi: area.nameHi },
          households: [...people.filter((p) => p.geoAreaId === turf.geoAreaId).map((p) => ({
            contactId: p.id, name: p.name,
            // Workers see only the last 4 digits: enough to confirm the right house, not enough to copy a list.
            phoneEnd: decrypt(p.phoneEnc, env.PHONE_ENC_KEY).slice(-4),
            lastResult: visits.find((v) => v.contactId === p.id)?.result ?? null,
          })), ...rollDoors],
          extraDoors: [...new Set(visits.filter((v) => v.turfId === turf.id && v.household && !rollLabels.has(v.household)).map((v) => v.household!))],
        };
      });
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
