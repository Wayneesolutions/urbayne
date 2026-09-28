import '../types.js';
import { Router } from 'express';
import { z } from 'zod';
import { schema, withTenant } from '@cs/db';
import { ah } from '../lib/http.js';
import { loadTenant, requireRole } from '../middleware/auth.js';
import type { Deps } from '../types.js';

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
    }).parse(req.body);
    const [row] = await withTenant(deps.pool, req.tenant!.id, (db) => db.insert(schema.geoAreas).values({ tenantId: req.tenant!.id, ...b }).returning());
    res.status(201).json(row);
  }));
  return r;
}
