import jwt from 'jsonwebtoken';

export interface AccessClaims { sub: string; wes?: boolean }

export const signAccess = (c: AccessClaims, secret: string) => jwt.sign(c, secret, { expiresIn: '15m' });
export const signRefresh = (sub: string, secret: string) => jwt.sign({ sub, typ: 'refresh' }, secret, { expiresIn: '30d' });

export function verifyAccess(token: string, secret: string): AccessClaims {
  const p = jwt.verify(token, secret);
  if (typeof p === 'string' || !p.sub) throw new Error('Invalid token');
  return { sub: p.sub, wes: Boolean(p.wes) };
}

export function verifyRefresh(token: string, secret: string): string {
  const p = jwt.verify(token, secret);
  if (typeof p === 'string' || p.typ !== 'refresh' || !p.sub) throw new Error('Invalid refresh token');
  return p.sub;
}
