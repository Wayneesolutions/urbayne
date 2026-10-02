import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../lib/db.js';
import { HttpError, notFound } from '../lib/errors.js';
import { requireCompany, requirePermission, requireRole } from '../middleware/auth.js';

// Mounted behind authenticate + requirePasswordChanged. There is no :companyId in any URL on purpose:
// the company is always the caller's own, taken from req.auth.
const router = Router();

const text = (max) => z.string().trim().max(max);
const fields = z.object({
  name: text(160).min(2),
  legalName: text(200).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  phone: text(30).nullable().optional(),
  website: z.string().trim().url().max(300).nullable().optional(),
  address: text(300).nullable().optional(),
  city: text(100).nullable().optional(),
  region: text(100).nullable().optional(),
  country: text(100).nullable().optional(),
  logoUrl: z.string().trim().url().max(500).nullable().optional(),
});

const COLUMNS = { name: 'name', legalName: 'legal_name', email: 'email', phone: 'phone', website: 'website', address: 'address', city: 'city', region: 'region', country: 'country', logoUrl: 'logo_url' };

const shape = (c) => ({
  id: c.id, name: c.name, legalName: c.legal_name, email: c.email, phone: c.phone, website: c.website,
  address: c.address, city: c.city, region: c.region, country: c.country, logoUrl: c.logo_url, createdAt: c.created_at, updatedAt: c.updated_at,
});

router.post('/', requireRole('OWNER'), async (req, res) => {
  if (req.auth.companyId) throw new HttpError(409, 'COMPANY_EXISTS', 'You already have a company');
  const body = fields.parse(req.body);
  const keys = Object.keys(COLUMNS).filter((k) => body[k] !== undefined);

  const company = await tx(async (db) => {
    // companies.owner_id is UNIQUE, so two parallel requests can't both succeed.
    const { rows } = await db.query(
      `INSERT INTO companies (owner_id, ${keys.map((k) => COLUMNS[k]).join(', ')})
       VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
      [req.auth.userId, ...keys.map((k) => body[k])],
    );
    await db.query('UPDATE users SET company_id = $1, updated_at = now() WHERE id = $2', [rows[0].id, req.auth.userId]);
    return rows[0];
  });
  res.status(201).json({ company: shape(company) });
});

router.get('/', requireCompany, requirePermission('company:read'), async (req, res) => {
  const { rows } = await query('SELECT * FROM companies WHERE id = $1', [req.auth.companyId]);
  if (!rows[0]) throw notFound('Company');
  res.json({ company: shape(rows[0]) });
});

router.patch('/', requireCompany, requirePermission('company:update'), async (req, res) => {
  const body = fields.partial().parse(req.body);
  const keys = Object.keys(COLUMNS).filter((k) => body[k] !== undefined);
  if (!keys.length) throw new HttpError(400, 'VALIDATION_ERROR', 'Nothing to update');

  const { rows } = await query(
    `UPDATE companies SET ${keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.auth.companyId, ...keys.map((k) => body[k])],
  );
  res.json({ company: shape(rows[0]) });
});

export default router;
