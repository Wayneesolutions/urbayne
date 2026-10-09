import jwt from 'jsonwebtoken';

/** wes: platform staff. sa: super admin. mcp: the person must choose a new password before doing anything else. */
export interface AccessClaims { sub: string; wes?: boolean; sa?: boolean; mcp?: boolean }

// The algorithm is pinned on both sides: a token cannot choose how it is checked ("none", RS256-as-HMAC, ...).
const ALG = 'HS256' as const;
const list = (s: string | string[]) => (Array.isArray(s) ? s : [s]).filter(Boolean);

export const signAccess = (c: AccessClaims, secret: string) => jwt.sign(c, secret, { expiresIn: '15m', algorithm: ALG });
export const signRefresh = (sub: string, sid: string, secret: string) => jwt.sign({ sub, sid, typ: 'refresh' }, secret, { expiresIn: '30d', algorithm: ALG });

/**
 * Verifies with the current secret, then with previous ones. Rotating a secret is therefore: add the old value as
 * *_PREVIOUS, deploy, wait for tokens signed with it to expire (15 minutes for access, 30 days for refresh), remove it.
 */
function verifyWith(token: string, secrets: string | string[]) {
  let last: unknown = new Error('No secret configured');
  for (const s of list(secrets)) {
    try { return jwt.verify(token, s, { algorithms: [ALG] }); } catch (e) { last = e; }
  }
  throw last;
}

export function verifyAccess(token: string, secrets: string | string[]): AccessClaims {
  const p = verifyWith(token, secrets);
  if (typeof p === 'string' || !p.sub) throw new Error('Invalid token');
  return { sub: p.sub, wes: Boolean(p.wes), sa: Boolean(p.sa), mcp: Boolean(p.mcp) };
}

export function verifyRefresh(token: string, secrets: string | string[]): { sub: string; sid: string } {
  const p = verifyWith(token, secrets);
  if (typeof p === 'string' || p.typ !== 'refresh' || !p.sub || typeof p.sid !== 'string') throw new Error('Invalid refresh token');
  return { sub: p.sub, sid: p.sid };
}
