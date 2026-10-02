import { readdirSync, readFileSync } from 'node:fs';
import { pool } from '../src/lib/db.js';

const dir = new URL('../sql/', import.meta.url);
for (const f of readdirSync(dir).sort()) {
  await pool.query(readFileSync(new URL(f, dir), 'utf8'));
  console.log('applied', f);
}
await pool.end();
