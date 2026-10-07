import '../../types.js';
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { schema, withTenant } from '@cs/db';
import { eq } from 'drizzle-orm';
import { HttpError, ah } from '../../lib/http.js';
import { loadTenant } from '../../middleware/auth.js';
import { PURPOSE_RULES, loadFile } from './files.js';
import type { Deps } from '../../types.js';

/** Reads an upload body as bytes (the request body IS the file). Caps the size per route. */
export const rawUpload = (maxBytes: number): RequestHandler => express.raw({ type: () => true, limit: maxBytes });

/** The upload's name, from the X-File-Name header (never trusted as a path). */
export const uploadName = (req: express.Request) => {
  const h = req.headers['x-file-name'];
  try { return typeof h === 'string' ? decodeURIComponent(h) : undefined; } catch { return undefined; }
};

/** Sends a stored file back: inline for images and PDFs, as a download for everything else. Never sniffed or executed by the browser. */
export function sendBlob(res: express.Response, body: Buffer, contentType: string, name?: string | null) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  const inline = contentType.startsWith('image/') || contentType === 'application/pdf';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${(name ?? 'file').replace(/["\\\r\n]/g, '_')}"`);
  res.end(body);
}

/** Download any stored file of this campaign. Who may read it depends on what it is for. */
export function fileRoutes(deps: Deps) {
  const r = Router({ mergeParams: true });
  r.use(loadTenant(deps));

  r.get('/:fileId', ah(async (req, res) => {
    const id = z.string().uuid().parse(req.params.fileId);
    const t = req.tenant!;
    const [meta] = await withTenant(deps.pool, t.id, (db) => db.select({ purpose: schema.storedFiles.purpose }).from(schema.storedFiles).where(eq(schema.storedFiles.id, id)));
    if (!meta) throw new HttpError(404, 'FILE_NOT_FOUND');
    const allowed = [...PURPOSE_RULES[meta.purpose]!.roles, 'wes_admin'];
    if (!req.role || !allowed.includes(req.role)) throw new HttpError(403, 'FORBIDDEN');
    const { file, body } = await withTenant(deps.pool, t.id, (db) => loadFile(deps, db, id));
    sendBlob(res, body, file.contentType, file.originalName);
  }));

  return r;
}
