import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

/** The hash that ties a recording to the exact text it was made from. */
export const bodyHash = (body: string) => createHash('sha256').update(body.normalize('NFC')).digest('hex');

/**
 * Sends a recording with HTTP Range support (iPhones will not play audio without it) and a long cache lifetime: the
 * ETag is the recording's own checksum, so a re-recording is a new URL state and old copies are never replayed.
 */
export function serveAudio(req: Request, res: Response, buf: Buffer, type: string, etag: string) {
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', `"${etag}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.headers['if-none-match'] === `"${etag}"`) { res.status(304).end(); return; }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (!m || (m[1] === '' && m[2] === '')) { res.setHeader('Content-Length', String(buf.length)); res.end(buf); return; }
  let start = m[1] === '' ? Math.max(0, buf.length - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
  if (start >= buf.length || start > end) { res.status(416).setHeader('Content-Range', `bytes */${buf.length}`); res.end(); return; }
  start = Math.max(0, start);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
  res.setHeader('Content-Length', String(end - start + 1));
  res.end(buf.subarray(start, end + 1));
}

export interface CoverageRow { id: string; title: string; locale: string; status: string; geoAreaId: string | null; audio: 'none' | 'ready' | 'stale'; recordedBy: string | null; durationMs: number | null }

/** Which pages have a recording, which recordings are out of date, and which pages still need one. */
export async function audioCoverage(db: Db): Promise<CoverageRow[]> {
  const pages = await db.select().from(schema.contentItems).where(eq(schema.contentItems.kind, 'page'));
  const clips = pages.length ? await db.select().from(schema.audioClips).where(inArray(schema.audioClips.contentItemId, pages.map((p) => p.id))) : [];
  return pages.map((p) => {
    const c = clips.find((x) => x.contentItemId === p.id);
    return { id: p.id, title: p.title, locale: p.locale, status: p.status, geoAreaId: p.geoAreaId, audio: !c ? 'none' as const : c.bodySha256 === bodyHash(p.body) ? 'ready' as const : 'stale' as const, recordedBy: c?.recordedBy ?? null, durationMs: c?.durationMs ?? null };
  }).sort((a, b) => a.locale.localeCompare(b.locale) || a.title.localeCompare(b.title));
}

/** Ids of approved pages whose recording matches their current text: the only ones the public may be sent. */
export async function playableClips(db: Db, pageIds: string[]) {
  if (!pageIds.length) return new Map<string, { fileId: string; sha: string }>();
  const rows = await db.select({ clip: schema.audioClips, body: schema.contentItems.body }).from(schema.audioClips)
    .innerJoin(schema.contentItems, eq(schema.contentItems.id, schema.audioClips.contentItemId))
    .where(and(inArray(schema.audioClips.contentItemId, pageIds), inArray(schema.contentItems.status, ['approved', 'certified'])));
  return new Map(rows.filter((r) => r.clip.bodySha256 === bodyHash(r.body)).map((r) => [r.clip.contentItemId, { fileId: r.clip.fileId, sha: r.clip.bodySha256 }]));
}
