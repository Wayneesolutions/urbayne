import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';
import { fakeVerify, hashPassword, signSuperAdminToken, signUserToken, verifyPassword, verifySuperAdmin } from '../lib/security.js';
import { assertApproved, authenticate } from '../middleware/auth.js';
import { env } from '../config.js';

const router = Router();

const limiter = (max) =>
  rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } } });

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'Password must be at least 8 characters').max(72);
const credentials = z.object({ email, password: z.string().min(1).max(200) });
const invalid = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, approvalStatus: u.approval_status, companyId: u.company_id, mustChangePassword: u.must_change_password });

// --- Super Admin: checked against .env only ---
router.post('/super-admin/login', limiter(5), async (req, res) => {
  const body = credentials.parse(req.body);
  if (!(await verifySuperAdmin(body.email, body.password))) throw invalid();
  res.json({ token: signSuperAdminToken(), user: { role: 'SUPER_ADMIN', email: env.SUPER_ADMIN_EMAIL } });
});

// --- Owner self-registration ---
router.post('/register', limiter(10), async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(120), email, password, phone: z.string().trim().max(30).optional() }).parse(req.body);
  if (body.email === env.SUPER_ADMIN_EMAIL) throw new HttpError(409, 'CONFLICT', 'Email is already in use');

  const { rows } = await query(
    `INSERT INTO users (role, name, email, phone, password_hash, created_via, approval_status)
     VALUES ('OWNER', $1, $2, $3, $4, 'SELF', 'PENDING') RETURNING *`,
    [body.name, body.email, body.phone ?? null, await hashPassword(body.password)],
  );
  // No token here: the account can't be used until the Super Admin approves it.
  res.status(201).json({
    status: 'PENDING_APPROVAL',
    message: 'Registration received. You can log in once your account is approved.',
    user: publicUser(rows[0]),
  });
});

// --- Owner + company user login ---
router.post('/login', limiter(10), async (req, res) => {
  const body = credentials.parse(req.body);
  const { rows } = await query(
    `SELECT u.*, o.is_active AS owner_active
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       LEFT JOIN users o ON o.id = c.owner_id
      WHERE u.email = $1`,
    [body.email],
  );
  const user = rows[0];
  if (!user) {
    await fakeVerify(body.password);
    throw invalid();
  }
  if (!(await verifyPassword(body.password, user.password_hash))) throw invalid();
  // Checked only after the password matches, so strangers can't probe an email's approval state.
  assertApproved(user);
  if (!user.is_active) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  if (user.owner_active === false) throw new HttpError(403, 'COMPANY_SUSPENDED', 'This company has been suspended');

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  res.json({ token: signUserToken(user), user: publicUser(user) });
});

router.get('/me', authenticate, async (req, res) => {
  if (req.auth.role === 'SUPER_ADMIN') return res.json({ user: { role: 'SUPER_ADMIN', email: env.SUPER_ADMIN_EMAIL } });
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.auth.userId]);
  res.json({ user: { ...publicUser(rows[0]), permissions: req.auth.permissions } });
});

// Works even while mustChangePassword is true (that's the whole point).
router.post('/change-password', authenticate, async (req, res) => {
  if (req.auth.role === 'SUPER_ADMIN') throw new HttpError(400, 'NOT_SUPPORTED', 'Super Admin password is changed in the server environment');
  const body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }).parse(req.body);

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.auth.userId]);
  if (!(await verifyPassword(body.currentPassword, rows[0].password_hash))) throw new HttpError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  if (body.currentPassword === body.newPassword) throw new HttpError(400, 'SAME_PASSWORD', 'New password must be different');

  // token_version bump logs out every other session; we hand back a fresh token for this one.
  const updated = await query(
    `UPDATE users SET password_hash = $1, must_change_password = false, token_version = token_version + 1, updated_at = now()
      WHERE id = $2 RETURNING *`,
    [await hashPassword(body.newPassword), req.auth.userId],
  );
  res.json({ token: signUserToken(updated.rows[0]), user: publicUser(updated.rows[0]) });
});

export default router;
