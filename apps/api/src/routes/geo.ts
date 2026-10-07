import '../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { schema, withTenant } from '@cs/db';
import { eq } from 'drizzle-orm';
import { HttpError, ah } from '../lib/http.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import type { Deps } from '../types.js';

const lng = z.number().min(-180).max(180), lat = z.number().min(-90).max(90);
const pos = z.tuple([lng, lat]);
/** Where an area is on the map: a point (a village or a booth), or an outline (a ward or a constituency). GeoJSON, longitude first. */
export const shapeSchema = z.union([
  z.object({ type: z.literal('Point'), coordinates: pos }).strict(),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(pos).min(4).max(2000)).min(1).max(5) }).strict(),
]);

export function geoRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  r.use(loadTenant(deps));
  r.get('/', ah(async (req, res) => {
    res.json(await withTenant(deps.pool, req.tenant!.id, (db) => db.select().from(schema.geoAreas).orderBy(schema.geoAreas.level, schema.geoAreas.nameEn)));
  }));
  r.post('/', requireRole('owner', 'manager'), ah(async (req, res) => {
    const b = z.object({
      parentId: z.string().uuid().optional(), level: z.string().min(2).max(30), code: z.string().max(40).optional(),
      nameEn: z.string().min(1).max(120), namePa: z.string().max(120).optional(), nameHi: z.string().max(120).optional(),
      shape: shapeSchema.optional(),
    }).parse(req.body);
    const { shape, ...rest } = b;
    const [row] = await withTenant(deps.pool, req.tenant!.id, (db) => db.insert(schema.geoAreas).values({ tenantId: req.tenant!.id, ...rest, polygon: shape ?? null }).returning());
    res.status(201).json(row);
  }));
  /** Put an area on the map, or move it (or clear it with null). */
  r.patch('/:id', requireRole('owner', 'manager'), ah(async (req, res) => {
    const b = z.object({ shape: shapeSchema.nullable() }).strict().parse(req.body);
    const id = z.string().uuid().parse(req.params.id);
    const [row] = await withTenant(deps.pool, req.tenant!.id, (db) => db.update(schema.geoAreas).set({ polygon: b.shape, updatedAt: new Date() }).where(eq(schema.geoAreas.id, id)).returning());
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    res.json(row);
  }));
  return r;
}
