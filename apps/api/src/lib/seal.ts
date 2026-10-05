import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Stable JSON: object keys sorted, so the same pack always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const signHash = (hash: string, key: string) => createHmac('sha256', key).update(hash).digest('hex');

export function verifySignature(hash: string, signature: string, key: string): boolean {
  const expected = Buffer.from(signHash(hash, key));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
