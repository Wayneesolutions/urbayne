import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { HttpError, notFound } from '../lib/errors.js';
import { generateTempPassword, hashPassword } from '../lib/security.js';
import { env } from '../config.js';

// Mounted behind authenticate + requireRole('SUPER_ADMIN').
const router = Router();
const id = z.string().uuid();

const OWNER_SELECT = `
  SELECT u.id, u.name, u.email, u.phone, u.is_active, u.must_change_password, u.created_via, u.last_login_at, u.created_at,
         u.approval_status, u.approved_at, u.rejection_reason,
         c.id AS company_id, c.name AS company_name,
         (SELECT count(*)::int FROM users m WHERE m.company_id = c.id AND m.role <> 'OWNER') AS user_count
    FROM users u
    LEFT JOIN companies c ON c.owner_id = u.id
   WHERE u.role = 'OWNER'`;

const shape = (r) => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, isActive: r.is_active, mustChangePassword: r.must_change_password,
  approvalStatus: r.approval_status, approvedAt: r.approved_at, rejectionReason: r.rejection_reason,
  createdVia: r.created_via, lastLoginAt: r.last_login_at, createdAt: r.created_at,
  company: r.company_id ? { id: r.company_id, name: r.company_name, userCount: r.user_count } : null,
});

router.get('/owners', async (req, res) => {
  const q = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), search: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
  const params = [q.limit, (q.page - 1) * q.limit];
  let where = '';
  if (q.search) {
    params.push(`%${q.search}%`);
    where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR c.name ILIKE $${params.length})`;
  }
  if (q.status) {
    params.push(q.status);
    where += ` AND u.approval_status = $${params.length}`;
  }
  const [{ rows }, pending] = await Promise.all([
    query(`${OWNER_SELECT}${where} ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`, params),
    query(`SELECT count(*)::int AS n FROM users WHERE role = 'OWNER' AND approval_status = 'PENDING'`),
  ]);
  // pendingCount is for the "awaiting approval" badge in the Super Admin panel.
  res.json({ owners: rows.map(shape), page: q.page, limit: q.limit, pendingCount: pending.rows[0].n });
});

router.post('/owners', async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254), phone: z.string().trim().max(30).optional() }).parse(req.body);
  if (body.email === env.SUPER_ADMIN_EMAIL) throw new HttpError(409, 'CONFLICT', 'Email is already in use');

  const temporaryPassword = generateTempPassword();
  const { rows } = await query(
    `INSERT INTO users (role, name, email, phone, password_hash, must_change_password, created_via, approval_status, approved_at)
     VALUES ('OWNER', $1, $2, $3, $4, true, 'SUPER_ADMIN', 'APPROVED', now()) RETURNING id`,
    [body.name, body.email, body.phone ?? null, await hashPassword(temporaryPassword)],
  );
  const owner = await query(`${OWNER_SELECT} AND u.id = $1`, [rows[0].id]);
  // The plain password exists only in this response. It is never stored and can't be fetched again.
  res.status(201).json({ owner: shape(owner.rows[0]), credentials: { email: body.email, temporaryPassword } });
});

router.get('/owners/:id', async (req, res) => {
  const { rows } = await query(`${OWNER_SELECT} AND u.id = $1`, [id.parse(req.params.id)]);
  if (!rows[0]) throw notFound('Owner');
  res.json({ owner: shape(rows[0]) });
});

// isActive=false suspends the Owner AND locks out every user in their company (checked in authenticate).
router.patch('/owners/:id', async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).nullable(), isActive: z.boolean() }).partial().parse(req.body);
  const { rows } = await query(
    `UPDATE users SET name = COALESCE($2, name),
                      phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
                      is_active = COALESCE($5, is_active),
                      updated_at = now()
      WHERE id = $1 AND role = 'OWNER' RETURNING id`,
    [id.parse(req.params.id), body.name ?? null, body.phone !== undefined, body.phone ?? null, body.isActive ?? null],
  );
  if (!rows[0]) throw notFound('Owner');
  const owner = await query(`${OWNER_SELECT} AND u.id = $1`, [rows[0].id]);
  res.json({ owner: shape(owner.rows[0]) });
});

// Approve a self-registered Owner. Also works on a REJECTED one (Super Admin changed their mind).
router.post('/owners/:id/approve', async (req, res) => {
  const ownerId = id.parse(req.params.id);
  await query(
    `UPDATE users SET approval_status = 'APPROVED', approved_at = now(), rejection_reason = NULL, updated_at = now()
      WHERE id = $1 AND role = 'OWNER' AND approval_status <> 'APPROVED'`,
    [ownerId],
  );
  const { rows } = await query(`${OWNER_SELECT} AND u.id = $1`, [ownerId]);
  if (!rows[0]) throw notFound('Owner');
  res.json({ owner: shape(rows[0]) });
});

// Only PENDING registrations can be rejected. To block an already-approved Owner, use PATCH isActive=false.
router.post('/owners/:id/reject', async (req, res) => {
  const ownerId = id.parse(req.params.id);
  const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const updated = await query(
    `UPDATE users SET approval_status = 'REJECTED', rejection_reason = $2, updated_at = now()
      WHERE id = $1 AND role = 'OWNER' AND approval_status = 'PENDING' RETURNING id`,
    [ownerId, body.reason ?? null],
  );
  const { rows } = await query(`${OWNER_SELECT} AND u.id = $1`, [ownerId]);
  if (!rows[0]) throw notFound('Owner');
  if (!updated.rows[0]) throw new HttpError(409, 'NOT_PENDING', 'Only pending registrations can be rejected');
  res.json({ owner: shape(rows[0]) });
});

router.post('/owners/:id/reset-password', async (req, res) => {
  const temporaryPassword = generateTempPassword();
  const { rows } = await query(
    `UPDATE users SET password_hash = $2, must_change_password = true, token_version = token_version + 1, updated_at = now()
      WHERE id = $1 AND role = 'OWNER' RETURNING email`,
    [id.parse(req.params.id), await hashPassword(temporaryPassword)],
  );
  if (!rows[0]) throw notFound('Owner');
  res.json({ credentials: { email: rows[0].email, temporaryPassword } });
});

export default router;
