import '../../types.js';
import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { desc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { HttpError, ah } from '../../lib/http.js';
import { loadTenant, requireRole } from '../../middleware/auth.js';
import { shortCode } from '../../lib/util.js';
import type { Deps } from '../../types.js';

/**
 * Share links for people to paste into WhatsApp BY HAND, and QR codes for print.
 * The platform never sends WhatsApp messages itself.
 */
export function shareRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  const { pool, env } = deps;
  r.use(loadTenant(deps));
  const url = (code: string) => `${env.PUBLIC_BASE_URL}/s/${code}`;

  r.get('/', ah(async (req, res) => {
    const rows = await withTenant(pool, req.tenant!.id, (db) => db.select().from(schema.shareLinks).orderBy(desc(schema.shareLinks.createdAt)));
    res.json(rows.map((x) => ({ ...x, url: url(x.code) })));
  }));

  r.post('/', requireRole('owner', 'manager', 'coordinator'), ah(async (req, res) => {
    const t = req.tenant!;
    if (!t.slug) throw new HttpError(422, 'SLUG_REQUIRED', 'Set a public page address for this campaign first.');
    const b = z.object({ label: z.string().min(1).max(80), geoAreaId: z.string().uuid().optional() }).parse(req.body);
    const row = await withTenant(pool, t.id, async (db) => {
      const [x] = await db.insert(schema.shareLinks).values({ tenantId: t.id, code: shortCode(), label: b.label, geoAreaId: b.geoAreaId, workerUserId: req.user!.id }).returning();
      return x!;
    });
    res.status(201).json({ ...row, url: url(row.code) });
  }));

  /** Ready-to-paste text: an approved/certified ad content item plus the link. */
  r.get('/:code/message', ah(async (req, res) => {
    const t = req.tenant!;
    const contentId = z.string().uuid().parse(req.query.contentId);
    const msg = await withTenant(pool, t.id, async (db) => {
      const [link] = await db.select().from(schema.shareLinks).where(eq(schema.shareLinks.code, req.params.code!));
      const [item] = await db.select().from(schema.contentItems).where(eq(schema.contentItems.id, contentId));
      if (!link || !item) throw new HttpError(404, 'NOT_FOUND');
      if (item.kind !== 'ad' || item.status === 'draft') throw new HttpError(422, 'APPROVED_AD_REQUIRED', 'Only approved (and in India, MCMC-certified) messages can be shared.');
      return `${item.body}\n${url(link.code)}`;
    });
    res.json({ text: msg });
  }));

  r.get('/:code/qr.svg', ah(async (req, res) => {
    const t = req.tenant!;
    const [link] = await withTenant(pool, t.id, (db) => db.select().from(schema.shareLinks).where(eq(schema.shareLinks.code, req.params.code!)));
    if (!link) throw new HttpError(404, 'NOT_FOUND');
    res.type('image/svg+xml').send(await QRCode.toString(url(link.code), { type: 'svg', margin: 1, width: 512 }));
  }));

  return r;
}

export function shortLinkRedirect(deps: Deps) {
  const r = Router();
  r.get('/:code', ah(async (req, res) => {
    const { rows } = await deps.pool.query('SELECT slug FROM resolve_share_link($1)', [req.params.code]);
    if (!rows[0]?.slug) throw new HttpError(404, 'NOT_FOUND');
    res.redirect(302, `/v/${rows[0].slug}?ref=${encodeURIComponent(req.params.code!)}`);
  }));
  return r;
}
