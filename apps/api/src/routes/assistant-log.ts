import '../types.js';
import { Router } from 'express';
import { desc, sql } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { ah } from '../lib/http.js';
import { loadTenant } from '../middleware/auth.js';
import type { Deps } from '../types.js';

export function assistantLogRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  r.use(loadTenant(deps));
  r.get('/', ah(async (req, res) => {
    const out = await withTenant(deps.pool, req.tenant!.id, async (db) => ({
      recent: await db.select().from(schema.assistantQuestions).orderBy(desc(schema.assistantQuestions.createdAt)).limit(50),
      byOutcome: await db.select({ outcome: schema.assistantQuestions.outcome, n: sql<number>`count(*)::int` }).from(schema.assistantQuestions).groupBy(schema.assistantQuestions.outcome),
    }));
    res.json(out);
  }));
  return r;
}
