import { query } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { effectivePermissions } from '../lib/permissions.js';
import { verifyToken } from '../lib/security.js';

export function assertApproved(user) {
  if (user.approval_status === 'PENDING') throw new HttpError(403, 'PENDING_APPROVAL', 'Your account is waiting for approval');
  if (user.approval_status === 'REJECTED') throw new HttpError(403, 'REGISTRATION_REJECTED', 'Your registration was not approved');
}

const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', msg);

/**
 * Sets req.auth to one of:
 *   { role: 'SUPER_ADMIN' }
 *   { role, userId, companyId, permissions, mustChangePassword }
 * companyId always comes from the database row, never from the token or the request.
 */
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw unauthorized('Invalid or expired token');
  }

  if (payload.role === 'SUPER_ADMIN' && payload.sub === 'super-admin') {
    req.auth = { role: 'SUPER_ADMIN' };
    return next();
  }

  // Loaded on every request so suspension / password change / role change apply immediately.
  const { rows } = await query(
    `SELECT u.id, u.role, u.company_id, u.permissions, u.is_active, u.must_change_password, u.token_version, u.approval_status,
            o.is_active AS owner_active
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       LEFT JOIN users o ON o.id = c.owner_id
      WHERE u.id = $1`,
    [payload.sub],
  );
  const user = rows[0];
  if (!user || user.token_version !== payload.tv) throw unauthorized('Session is no longer valid');
  assertApproved(user);
  if (!user.is_active) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  if (user.owner_active === false) throw new HttpError(403, 'COMPANY_SUSPENDED', 'This company has been suspended');

  req.auth = {
    role: user.role,
    userId: user.id,
    companyId: user.company_id,
    permissions: effectivePermissions(user),
    mustChangePassword: user.must_change_password,
  };
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.auth.role)) throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource');
  next();
};

// Shorthand: any Owner or company user, but never the Super Admin.
export const requireTenantUser = requireRole('OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'VIEWER');

export const requirePermission = (...needed) => (req, _res, next) => {
  if (!needed.every((p) => req.auth.permissions?.includes(p))) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to do this');
  }
  next();
};

// Accounts created with a temporary password can do nothing until they set their own.
export function requirePasswordChanged(req, _res, next) {
  if (req.auth.mustChangePassword) {
    throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password to continue');
  }
  next();
}

// Use on every tenant-data route. Guarantees req.auth.companyId exists.
export function requireCompany(req, _res, next) {
  if (!req.auth.companyId) throw new HttpError(409, 'COMPANY_REQUIRED', 'Create your company first');
  next();
}
