import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, withTenant, type FilePurpose } from '@cs/db';
import { HttpError } from '../../lib/http.js';
import type { Deps } from '../../types.js';

type Db = Parameters<Parameters<typeof withTenant>[2]>[0];

export interface FileKind { type: string; ext: string }

/**
 * What the bytes really are, from the first bytes of the file, never from the name or the Content-Type the caller claims.
 * Returns null for anything else.
 */
export function sniff(buf: Buffer): FileKind | null {
  const b = buf;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (b.toString('latin1', 0, 5) === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  if (b.toString('latin1', 0, 4) === 'PK\u0003\u0004') return { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return { type: 'audio/wav', ext: 'wav' };
  if (b.toString('latin1', 0, 4) === 'OggS') return { type: 'audio/ogg', ext: 'ogg' };
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return { type: 'audio/mpeg', ext: 'mp3' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: 'audio/webm', ext: 'webm' };
  if (b.toString('latin1', 4, 8) === 'ftyp') return { type: 'audio/mp4', ext: 'm4a' };
  if (looksLikeText(b)) return { type: 'text/csv', ext: 'csv' };
  return null;
}

/** Plain text that decodes as UTF-8 (a CSV export). A NUL byte or a broken character means it is something else. */
export function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 3)); return true; } catch { return false; }
}

/** What each kind of upload may contain, and how large it may be. */
export const PURPOSE_RULES: Record<FilePurpose, { types: string[]; maxBytes: number; roles: readonly string[] }> = {
  receipt: { types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], maxBytes: 8 * 1024 * 1024, roles: ['owner', 'manager', 'finance_agent'] },
  bank_statement: { types: ['text/csv'], maxBytes: 5 * 1024 * 1024, roles: ['owner', 'finance_agent'] },
  roll_proof: { types: ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'image/jpeg', 'image/png'], maxBytes: 25 * 1024 * 1024, roles: ['owner', 'manager', 'coordinator'] },
  audio: { types: ['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/wav'], maxBytes: 4 * 1024 * 1024, roles: ['owner', 'manager'] },
};
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const cleanName = (n: string | undefined) => n?.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || undefined;

/** Checks the bytes against the rules for this purpose, stores them in the region's bucket and records them. */
export async function saveFile(deps: Deps, db: Db, tenantId: string, userId: string, purpose: FilePurpose, buf: Buffer, originalName?: string) {
  const rule = PURPOSE_RULES[purpose]!;
  if (!buf.length) throw new HttpError(400, 'EMPTY_FILE', 'Nothing was uploaded.');
  if (buf.length > rule.maxBytes) throw new HttpError(413, 'FILE_TOO_LARGE', `This kind of file can be at most ${Math.round(rule.maxBytes / 1024 / 1024)} MB.`);
  const kind = sniff(buf);
  if (!kind || !rule.types.includes(kind.type)) throw new HttpError(415, 'FILE_TYPE_NOT_ALLOWED', `Allowed: ${rule.types.map((t) => t.split('/')[1]).join(', ')}.`);
  const key = `${tenantId}/${purpose}/${randomUUID()}.${kind.ext}`;
  await deps.store.put(key, buf, kind.type);
  const [row] = await db.insert(schema.storedFiles).values({
    tenantId, purpose, storageKey: key, contentType: kind.type, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'),
    originalName: cleanName(originalName), uploadedBy: userId,
  }).returning();
  return row!;
}

/** Loads a file's record and bytes; 404 if it is not this campaign's, or was removed. */
export async function loadFile(deps: Deps, db: Db, fileId: string, purpose?: FilePurpose) {
  const [f] = await db.select().from(schema.storedFiles).where(and(eq(schema.storedFiles.id, fileId), isNull(schema.storedFiles.deletedAt)));
  if (!f || (purpose && f.purpose !== purpose)) throw new HttpError(404, 'FILE_NOT_FOUND');
  const body = await deps.store.get(f.storageKey);
  if (!body) throw new HttpError(404, 'FILE_NOT_FOUND');
  return { file: f, body };
}

/** Removes the bytes and marks the record. Safe to repeat. */
export async function deleteFiles(deps: Deps, db: Db, where: ReturnType<typeof and> | ReturnType<typeof eq>) {
  const rows = await db.select().from(schema.storedFiles).where(and(where, isNull(schema.storedFiles.deletedAt)));
  for (const f of rows) {
    await deps.store.delete(f.storageKey);
    await db.update(schema.storedFiles).set({ deletedAt: new Date() }).where(eq(schema.storedFiles.id, f.id));
  }
  return rows.length;
}
