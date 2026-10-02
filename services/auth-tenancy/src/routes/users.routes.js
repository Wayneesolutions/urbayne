import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { HttpError, notFound } from '../lib/errors.js';
import { ASSIGNABLE_ROLES, PERMISSIONS, effectivePermissions } from '../lib/permissions.js';
import { generateTempPassword, hashPassword } from '../lib/security.js';
import { requirePermission } from '../middleware/auth.js';
import { env } from '../config.js';

// Mounted behind authenticate + requirePasswordChanged + requireCompany.
// Every query below filters on req.auth.companyId, so an id from another company is simply "not found".
const router = Router();
const id = z.string().uuid();
const role = z.enum(ASSIGNABLE_ROLES);
const permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).nullable();

const shape = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, isActive: u.is_active,
  customPermissions: u.permissions, permissions: effectivePermissions(u),
  mustChangePassword: u.must_change_password, lastLoginAt: u.last_login_at, createdAt: u.created_at,
});

// Only the Owner can create/modify Admins or set custom permission lists (stops Admins escalating themselves or each other).
function guardPrivileged(req, { targetRole, newRole, touchesPermissions }) {
  if (req.auth.role === 'OWNER') return;
  if (targetRole === 'ADMIN' || newRole === 'ADMIN' || touchesPermissions) {
    throw new HttpError(403, 'FORBIDDEN', 'Only the owner can manage admins or custom permissions');
  }
}

async function findInCompany(req, userId) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1 AND company_id = $2', [userId, req.auth.companyId]);
  if (!rows[0]) throw notFound('User');
  if (rows[0].role === 'OWNER') throw new HttpError(403, 'FORBIDDEN', 'The owner account cannot be changed here');
  return rows[0];
}

router.get('/', requirePermission('users:read'), async (req, res) => {
  const { rows } = await query(`SELECT * FROM users WHERE company_id = $1 ORDER BY (role = 'OWNER') DESC, created_at`, [req.auth.companyId]);
  res.json({ users: rows.map(shape) });
});

router.get('/meta', requirePermission('users:read'), (_req, res) => {
  res.json({ roles: ASSIGNABLE_ROLES, permissions: PERMISSIONS });
});

router.post('/', requirePermission('users:manage'), async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().max(30).optional(),
    role,
    permissions: permissions.optional(),
  }).parse(req.body);
  guardPrivileged(req, { newRole: body.role, touchesPermissions: body.permissions != null });
  if (body.email === env.SUPER_ADMIN_EMAIL) throw new HttpError(409, 'CONFLICT', 'Email is already in use');

  const temporaryPassword = generateTempPassword();
  const { rows } = await query(
    `INSERT INTO users (company_id, role, name, email, phone, password_hash, permissions, must_change_password, created_via, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'OWNER', $8) RETURNING *`,
    [req.auth.companyId, body.role, body.name, body.email, body.phone ?? null, await hashPassword(temporaryPassword),
     body.permissions ? JSON.stringify(body.permissions) : null, req.auth.userId],
  );
  res.status(201).json({ user: shape(rows[0]), credentials: { email: body.email, temporaryPassword } });
});

router.get('/:id', requirePermission('users:read'), async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1 AND company_id = $2', [id.parse(req.params.id), req.auth.companyId]);
  if (!rows[0]) throw notFound('User');
  res.json({ user: shape(rows[0]) });
});

router.patch('/:id', requirePermission('users:manage'), async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().max(30).nullable(),
    role,
    permissions, // null = back to role defaults
    isActive: z.boolean(),
  }).partial().parse(req.body);

  const target = await findInCompany(req, id.parse(req.params.id));
  if (target.id === req.auth.userId) throw new HttpError(400, 'SELF_EDIT', 'You cannot change your own role or status');
  guardPrivileged(req, { targetRole: target.role, newRole: body.role, touchesPermissions: body.permissions !== undefined });

  const next = {
    name: body.name ?? target.name,
    phone: body.phone !== undefined ? body.phone : target.phone,
    role: body.role ?? target.role,
    permissions: body.permissions !== undefined ? body.permissions : target.permissions,
    is_active: body.isActive ?? target.is_active,
  };
  const { rows } = await query(
    `UPDATE users SET name = $3, phone = $4, role = $5, permissions = $6, is_active = $7, updated_at = now()
      WHERE id = $1 AND company_id = $2 RETURNING *`,
    [target.id, req.auth.companyId, next.name, next.phone, next.role, next.permissions ? JSON.stringify(next.permissions) : null, next.is_active],
  );
  res.json({ user: shape(rows[0]) });
});

router.post('/:id/reset-password', requirePermission('users:manage'), async (req, res) => {
  const target = await findInCompany(req, id.parse(req.params.id));
  guardPrivileged(req, { targetRole: target.role });
  const temporaryPassword = generateTempPassword();
  await query(
    `UPDATE users SET password_hash = $3, must_change_password = true, token_version = token_version + 1, updated_at = now()
      WHERE id = $1 AND company_id = $2`,
    [target.id, req.auth.companyId, await hashPassword(temporaryPassword)],
  );
  res.json({ credentials: { email: target.email, temporaryPassword } });
});

// Soft delete: keeps the row so records they created elsewhere still point at a real user.
router.delete('/:id', requirePermission('users:manage'), async (req, res) => {
  const target = await findInCompany(req, id.parse(req.params.id));
  if (target.id === req.auth.userId) throw new HttpError(400, 'SELF_EDIT', 'You cannot deactivate yourself');
  guardPrivileged(req, { targetRole: target.role });
  await query(
    `UPDATE users SET is_active = false, token_version = token_version + 1, updated_at = now() WHERE id = $1 AND company_id = $2`,
    [target.id, req.auth.companyId],
  );
  res.status(204).end();
});

export default router;
