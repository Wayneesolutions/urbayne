// Docker-free local Postgres for development and tests (real Postgres binaries via npm).
// Usage: pnpm pg:local   (keeps running; Ctrl+C to stop). Data lives in .local-pg/.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const dir = '.local-pg';
const PORT = Number(process.env.PG_PORT ?? 5433); // 5432 is blocked on some Windows machines
const fresh = !existsSync(`${dir}/PG_VERSION`);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'cs', password: 'cs', port: PORT, persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('campaign_suite');
console.log(`Postgres ready: postgres://cs:cs@localhost:${PORT}/campaign_suite`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
