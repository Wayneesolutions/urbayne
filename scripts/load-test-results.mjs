#!/usr/bin/env node
/**
 * Load test for poll day: many agents sending turnout reports while managers watch the live dashboard views.
 *
 * "Expected" poll-day traffic used here (a busy evening on the platform): 40 campaigns, 300 stations each, every agent reporting once an
 * hour, all within the same 5 minutes => about 40 reports per second, plus 40 people refreshing the turnout view every 30 seconds.
 * "10x" is therefore 400 reports per second and 400 viewers. Change the numbers with the flags below.
 *
 * It seeds its own campaigns straight into the database (so it is not slowed by login limits), signs its own tokens with the server's
 * JWT_SECRET, hits the REAL HTTP API, then removes everything it created. Use a test database, never production.
 *
 *   DATABASE_URL=postgres://cs:cs@localhost:5433/campaign_suite JWT_SECRET=... \
 *   node scripts/load-test-results.mjs --url http://localhost:4123 --rate 400 --viewers 400 --seconds 60
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const require = createRequire(path.resolve('apps/api/package.json'));
const pg = require('pg');
const jwt = require('jsonwebtoken');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const URL_ = arg('url', 'http://localhost:4123');
const RATE = Number(arg('rate', 400));              // report requests per second
const VIEWERS = Number(arg('viewers', 400));        // people refreshing the turnout view every 30 s
const SECONDS = Number(arg('seconds', 60));
const CAMPAIGNS = Number(arg('campaigns', 8));
const BOOTHS = Number(arg('booths', 300));
const AGENTS = Number(arg('agents', 60));           // per campaign
const DUP = Number(arg('duplicates', 0.05));        // share of requests that are phones retrying a batch already sent
const BIG = Number(arg('big-batches', 0.15));       // share of requests that are an offline phone flushing 10 numbers at once
const DB = process.env.DATABASE_URL, SECRET = process.env.JWT_SECRET;
if (!DB || !SECRET) { console.error('DATABASE_URL (owner) and JWT_SECRET (the server\'s) are required'); process.exit(2); }

const pool = new pg.Pool({ connectionString: DB, max: 4 });
const q = (sql, args) => pool.query(sql, args);
const tag = `lt${Date.now().toString(36)}`;
const tenants = [];

async function seed() {
  for (let c = 0; c < CAMPAIGNS; c++) {
    const tid = randomUUID();
    await q(`INSERT INTO tenants (id, region, race_type, seat_code, election_date, campaign_name, time_zone, slug)
             VALUES ($1, 'IN', 'assembly', $2, current_date, $3, 'Asia/Kolkata', $2)`, [tid, `${tag}-${c}`.toUpperCase(), `Load test ${c}`]);
    await q(`INSERT INTO geo_areas (tenant_id, level, code, name_en) SELECT $1, 'booth', 'B' || lpad(g::text, 4, '0'), 'Booth ' || g FROM generate_series(1, $2) g`, [tid, BOOTHS]);
    await q(`INSERT INTO polling_stations (tenant_id, geo_area_id, electors) SELECT $1, id, 400 + (random() * 600)::int FROM geo_areas WHERE tenant_id = $1`, [tid]);
    const users = (await q(`INSERT INTO users (phone_hash, phone_enc, name) SELECT $1 || g::text, 'x', 'agent' FROM generate_series(1, $2 + 1) g RETURNING id`, [`${tag}-${c}-`, AGENTS])).rows.map((r) => r.id);
    const [viewer, ...agents] = users;
    await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'manager')`, [tid, viewer]);
    for (const a of agents) await q(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'agent_reporter')`, [tid, a]);
    const stations = (await q(`SELECT id FROM geo_areas WHERE tenant_id = $1 ORDER BY code`, [tid])).rows.map((r) => r.id);
    // Each agent gets about BOOTHS/AGENTS stations.
    await q(`INSERT INTO result_agents (tenant_id, user_id, scope, geo_area_id) SELECT $1, ($2::uuid[])[1 + (i % $3)], 'station', ($4::uuid[])[i + 1] FROM generate_series(0, $5 - 1) i`, [tid, agents, AGENTS, stations, stations.length]);
    const mine = new Map();
    stations.forEach((s, i) => { const a = agents[i % AGENTS]; (mine.get(a) ?? mine.set(a, []).get(a)).push(s); });
    tenants.push({ id: tid, viewerToken: sign(viewer), agents: agents.map((a) => ({ token: sign(a), stations: mine.get(a) })) });
  }
}
const sign = (sub) => jwt.sign({ sub }, SECRET, { expiresIn: '3h', algorithm: 'HS256' });

async function cleanup() {
  await q(`DELETE FROM tenants WHERE slug LIKE $1`, [`${tag}-%`.toUpperCase()]);
  await q(`DELETE FROM users WHERE phone_hash LIKE $1`, [`${tag}-%`]);
}

// ---------------------------------------------------------------------------------------------------------------------
const lat = { report: [], view: [] };
const stat = { report: {}, view: {} };
let sent = 0, recorded = 0, duplicates = 0, itemErrors = 0, inflight = 0, maxInflight = 0;
const counters = new Map();
const recent = [];

async function http(kind, method, path, token, body) {
  const t0 = performance.now();
  inflight++; maxInflight = Math.max(maxInflight, inflight);
  try {
    const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    lat[kind].push(performance.now() - t0);
    stat[kind][res.status] = (stat[kind][res.status] ?? 0) + 1;
    return { status: res.status, json };
  } catch (e) {
    lat[kind].push(performance.now() - t0);
    stat[kind].network = (stat[kind].network ?? 0) + 1;
    return { status: 0, json: {} };
  } finally { inflight--; }
}

function reportRequest() {
  const t = tenants[Math.floor(Math.random() * tenants.length)];
  const a = t.agents[Math.floor(Math.random() * t.agents.length)];
  const n = Math.random() < BIG ? 10 : 1;
  const reports = Array.from({ length: n }, () => {
    const s = a.stations[Math.floor(Math.random() * a.stations.length)];
    const v = (counters.get(s) ?? 0) + 1 + Math.floor(Math.random() * 15);
    counters.set(s, v);
    return { clientUuid: randomUUID(), areaId: s, votesCast: v, asOf: new Date().toISOString() };
  });
  return { t, a, body: { reports } };
}

async function sendReport() {
  let req;
  if (recent.length && Math.random() < DUP) req = recent[Math.floor(Math.random() * recent.length)]; // a phone retrying
  else { req = reportRequest(); if (recent.push(req) > 500) recent.shift(); }
  const isRetry = recent.includes(req) && req.sentOnce;
  req.sentOnce = true;
  const { status, json } = await http('report', 'POST', `/api/t/${req.t.id}/results/turnout/batch`, req.a.token, req.body);
  sent++;
  if (status === 200) for (const r of json.results) { if (r.status === 'recorded') recorded++; else if (r.status === 'duplicate') duplicates++; else itemErrors++; }
  void isRetry;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const summary = (name, arr) => `${name.padEnd(8)} n=${String(arr.length).padStart(6)}  p50=${pct(arr, 50).toFixed(0).padStart(4)}ms  p95=${pct(arr, 95).toFixed(0).padStart(4)}ms  p99=${pct(arr, 99).toFixed(0).padStart(4)}ms  max=${Math.max(0, ...arr).toFixed(0)}ms`;

async function run() {
  const end = Date.now() + SECONDS * 1000;
  const tick = 50;
  const perTick = (RATE * tick) / 1000;
  let carry = 0;
  const loops = [];
  // Report traffic at a steady rate.
  loops.push((async () => {
    while (Date.now() < end) {
      carry += perTick; const n = Math.floor(carry); carry -= n;
      for (let i = 0; i < n; i++) sendReport();
      await sleep(tick);
    }
  })());
  // Each viewer refreshes the turnout view every 30 s, spread out over time.
  for (let v = 0; v < VIEWERS; v++) {
    const t = tenants[v % tenants.length];
    loops.push((async () => {
      await sleep(Math.random() * 30_000);
      while (Date.now() < end) { await http('view', 'GET', `/api/t/${t.id}/results/turnout`, t.viewerToken); await sleep(30_000); }
    })());
  }
  await Promise.all(loops);
  while (inflight > 0) await sleep(100);
}

console.log(`Seeding ${CAMPAIGNS} campaigns x ${BOOTHS} stations x ${AGENTS} agents ...`);
await seed();
console.log(`Running ${SECONDS}s: ${RATE} report requests/s (${Math.round(BIG * 100)}% carry 10 numbers, ${Math.round(DUP * 100)}% are retries), ${VIEWERS} viewers refreshing every 30 s ...`);
const t0 = Date.now();
await run();
const secs = (Date.now() - t0) / 1000;
const stored = (await q(`SELECT count(*)::int AS n FROM turnout_reports WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE $1)`, [`${tag}-%`.toUpperCase()])).rows[0].n;
const dupRows = (await q(`SELECT count(*)::int AS n FROM (SELECT client_uuid FROM turnout_reports WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE $1) GROUP BY client_uuid HAVING count(*) > 1) x`, [`${tag}-%`.toUpperCase()])).rows[0].n;

console.log('\n' + summary('reports', lat.report) + `  status ${JSON.stringify(stat.report)}`);
console.log(summary('viewers', lat.view) + `  status ${JSON.stringify(stat.view)}`);
console.log(`throughput: ${(sent / secs).toFixed(0)} report requests/s, ${(recorded / secs).toFixed(0)} numbers stored/s; peak in flight ${maxInflight}`);
console.log(`numbers recorded=${recorded} duplicates_ignored=${duplicates} item_errors=${itemErrors}; rows in database=${stored}; client ids stored twice=${dupRows}`);
const p95 = pct(lat.report, 95);
const bad = (stat.report[200] ?? 0) !== sent || itemErrors > 0 || stored !== recorded || dupRows > 0;
console.log(bad ? '\nFAIL: a request failed, a number was lost, or one was counted twice.' : `\nOK: nothing lost, nothing counted twice. report p95 ${p95.toFixed(0)} ms (${p95 < 500 ? 'within' : 'ABOVE'} the 500 ms goal).`);
await cleanup();
await pool.end();
process.exit(bad ? 1 : 0);
