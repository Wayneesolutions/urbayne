/**
 * Creates (or promotes) a super admin from the command line:
 *   DATABASE_URL=... pnpm --filter @cs/api create-superadmin you@example.com "Your Name"
 * The password comes from SUPERADMIN_PASSWORD; without it one is generated and printed once. It must be changed at first sign-in.
 */
import pg from 'pg';
import { createSuperAdmin } from '../lib/bootstrap.js';
import { generatePassword } from '../lib/password.js';

const url = process.env.DATABASE_URL;
const [email, name] = process.argv.slice(2);
if (!url || !email) throw new Error('Usage: DATABASE_URL=... create-superadmin <email> [name]');
const password = process.env.SUPERADMIN_PASSWORD ?? generatePassword();
const pool = new pg.Pool({ connectionString: url });
const r = await createSuperAdmin(pool, email, password, name);
console.log(`${r.created ? 'Created' : 'Promoted'} super admin ${email}`);
if (!process.env.SUPERADMIN_PASSWORD) console.log(`Temporary password (shown once, change it at first sign-in): ${password}`);
await pool.end();
