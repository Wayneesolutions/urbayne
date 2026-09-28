// CI guardrail (build guide, section 11): the platform must never ship WhatsApp
// automation or unofficial WhatsApp tooling. Fails the build if any workspace
// package depends on one.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const banned = [/whatsapp/i, /baileys/i, /wweb/i, /venom-bot/i, /wppconnect/i, /wa-automate/i];
const roots = ['apps', 'packages'];
const files = ['package.json'];
for (const r of roots) for (const d of readdirSync(r)) {
  const f = path.join(r, d, 'package.json');
  if (existsSync(f)) files.push(f);
}
let bad = [];
for (const f of files) {
  const p = JSON.parse(readFileSync(f, 'utf8'));
  for (const dep of Object.keys({ ...p.dependencies, ...p.devDependencies })) {
    if (banned.some((re) => re.test(dep))) bad.push(`${f}: ${dep}`);
  }
}
if (bad.length) {
  console.error('Banned dependencies found (see guardrails):\n' + bad.join('\n'));
  process.exit(1);
}
console.log(`guardrails ok (${files.length} package.json files checked)`);
