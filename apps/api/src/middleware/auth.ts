import type { RequestHandler } from 'express';
import { and, eq } from 'drizzle-orm';
import { schema, withTenant } from '@cs/db';
import { verifyAccess } from '../lib/jwt.js';
import { HttpError, ah } from '../lib/http.js';
import type { Deps, EffectiveRole } from '../types.js';

export const requireUser = (deps: Deps): RequestHandler => (req, _res, next) => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(new HttpError(401, 'UNAUTHENTICATED'));
  try {
    const c = verifyAccess(h.slice(7), [deps.env.JWT_SECRET, deps.env.JWT_SECRET_PREVIOUS ?? '']);
    req.user = { id: c.sub, wes: Boolean(c.wes), sa: Boolean(c.sa) };
    // A password someone else chose must be replaced first: until then only the sign-in and password routes work.
    if (c.mcp && !req.baseUrl.startsWith('/api/auth')) return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose your own password first.'));
    next();
  } catch {
    next(new HttpError(401, 'UNAUTHENTICATED'));
  }
};

/** Loads :tenantId and the caller's role in it. RLS scopes the lookup. */
export const loadTenant = (deps: Deps): RequestHandler =>
  ah(async (req, _res, next) => {
    const tenantId = req.params.tenantId;
    if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new HttpError(404, 'TENANT_NOT_FOUND');
    const user = req.user!;
    const found = await withTenant(deps.pool, tenantId, async (db) => {
      const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      if (!tenant) return null;
      const [m] = await db
        .select()
        .from(schema.memberships)
        .where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, user.id)));
      if (!m && user.wes) {
        // Support access to a campaign you are not a member of: read-only, needs a stated reason, and every request is logged with it.
        const reason = String(req.headers['x-support-reason'] ?? '').trim();
        if (reason.length < 10) throw new HttpError(403, 'SUPPORT_REASON_REQUIRED', 'Support access needs an X-Support-Reason header (at least 10 characters: ticket number and why).');
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(403, 'SUPPORT_READ_ONLY', 'Support access is read-only. Changes are made by the campaign owner.');
        await db.insert(schema.auditLog).values({
          tenantId, actorId: user.id, action: 'support_access', entity: 'tenant', entityId: tenantId, ip: req.ip,
          after: { reason: reason.slice(0, 300), method: req.method, path: req.originalUrl.split('?')[0] },
        });
      }
      return { tenant, role: (m?.role ?? (user.wes ? 'wes_admin' : null)) as EffectiveRole | null };
    });
    if (!found || !found.role) throw new HttpError(404, 'TENANT_NOT_FOUND');
    req.tenant = found.tenant;
    req.role = found.role;
    next();
  });

export const requireRole =
  (...roles: EffectiveRole[]): RequestHandler =>
  (req, _res, next) =>
    req.role && roles.includes(req.role) ? next() : next(new HttpError(403, 'FORBIDDEN'));
