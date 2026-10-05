import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

// Minimal migrator: applies migrations/*.sql in order, once each. Runs as the owner role.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await client.query('SELECT name FROM _migrations')).rows.map((r) => r.name));
for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  const sql = await readFile(path.join(dir, f), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
    await client.query('COMMIT');
    console.log(`applied ${f}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

// Migration 0001 creates the app role with a throwaway development password. Real deployments set the real one here.
const appPassword = process.env.APP_ROLE_PASSWORD;
if (process.env.NODE_ENV === 'production' && (!appPassword || appPassword.length < 24 || appPassword === 'cs_app')) {
  await client.end();
  throw new Error('APP_ROLE_PASSWORD (at least 24 characters) is required in production: the cs_app role must not keep its development password');
}
if (appPassword) {
  await client.query(`ALTER ROLE cs_app PASSWORD ${client.escapeLiteral(appPassword)}`);
  console.log('cs_app password set');
}
await client.end();
