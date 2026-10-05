/**
 * Checks your real Vapi account against what the platform expects, and (optionally) places ONE real test call to a number you choose.
 *
 *   VAPI_API_KEY=... VAPI_PHONE_NUMBER_ID=... VAPI_ASSISTANT_ID=... PUBLIC_BASE_URL=https://api.example.com \
 *   VAPI_WEBHOOK_SECRET=... pnpm --filter @cs/api vapi:verify [--call +91XXXXXXXXXX]
 *
 * Without --call it only reads (phone number, assistant). With --call it dials that number with a two-question demo survey,
 * waits for the call to end, and shows how the platform would record it (status, answers, cost). Use your own phone.
 * Nothing is written to any database.
 */
import { VapiVoice } from '@cs/channels';
import { parseEndOfCall, mapEndedReason } from '../modules/calls/vapi-report.js';

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(2); } return v; };
const apiKey = need('VAPI_API_KEY'), phoneNumberId = need('VAPI_PHONE_NUMBER_ID'), assistantId = need('VAPI_ASSISTANT_ID');
const base = process.env.VAPI_BASE_URL ?? 'https://api.vapi.ai';
const publicBase = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
const webhookSecret = process.env.VAPI_WEBHOOK_SECRET;
const callTo = process.argv.includes('--call') ? process.argv[process.argv.indexOf('--call') + 1] : undefined;

let warnings = 0, failures = 0;
const ok = (m: string) => console.log(`  PASS  ${m}`);
const warn = (m: string) => { warnings++; console.log(`  WARN  ${m}`); };
const fail = (m: string) => { failures++; console.log(`  FAIL  ${m}`); };
const get = async (path: string) => {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: res.ok ? ((await res.json()) as any) : null };
};

console.log('1. Phone number');
const pn = await get(`/phone-number/${encodeURIComponent(phoneNumberId)}`);
if (pn.status === 200) ok(`found (${pn.body.provider ?? 'unknown provider'}, ${pn.body.number ?? pn.body.name ?? 'no number shown'})`);
else fail(`could not read phone number ${phoneNumberId} (HTTP ${pn.status}); check VAPI_PHONE_NUMBER_ID and the key`);

console.log('2. Assistant');
const as = await get(`/assistant/${encodeURIComponent(assistantId)}`);
if (as.status !== 200) fail(`could not read assistant ${assistantId} (HTTP ${as.status})`);
else {
  ok(`found "${as.body.name ?? assistantId}"`);
  const text = JSON.stringify(as.body.model ?? {});
  if (text.includes('{{survey}}')) ok('prompt uses {{survey}} (the platform passes the approved questions there)');
  else warn('the assistant prompt does not contain {{survey}}: survey questions will not be asked. See docs/vapi-setup.md');
  if (as.body.artifactPlan?.recordingEnabled === true) warn('recording is ON at the assistant. The platform switches it off per call, but check this is what you want');
  if (as.body.keypadInputPlan?.enabled) ok('keypad (DTMF) input is enabled');
  else warn('keypad (DTMF) input is not enabled on the assistant: people can only answer by speaking');
}

console.log('3. Where Vapi will send the end-of-call report');
if (!publicBase) warn('PUBLIC_BASE_URL not set: cannot show the webhook address');
else {
  console.log(`  INFO  ${publicBase}/webhooks/vapi  (header X-Vapi-Secret must equal VAPI_WEBHOOK_SECRET)`);
  try { const r = await fetch(`${publicBase}/ready`); r.ok ? ok('the server answers on /ready') : warn(`/ready answered HTTP ${r.status}`); }
  catch { warn('could not reach PUBLIC_BASE_URL from here (fine if it is only reachable from Vapi)'); }
}
if (!webhookSecret || webhookSecret.length < 16) warn('VAPI_WEBHOOK_SECRET is missing or shorter than 16 characters');

if (callTo) {
  console.log(`4. Test call to ${callTo.slice(0, -4)}****`);
  const survey = [{ key: 'top_issue', question: 'What matters most to you: roads or water?', options: [{ value: 'roads', label: 'Roads', dtmf: '1' }, { value: 'water', label: 'Water', dtmf: '2' }] }];
  const voice = new VapiVoice({ apiKey, phoneNumberId, assistantId, baseUrl: base, serverUrl: publicBase ? `${publicBase}/webhooks/vapi` : undefined, webhookSecret, recording: false });
  const started = await voice.startCall({
    to: callTo, locale: 'en', survey,
    script: 'This is an automated call from an AI assistant, a test of the campaign system. Please answer two quick questions or just say stop.',
    metadata: { tenantId: 'verify', interactionId: `verify-${Date.now()}` },
  });
  if (started.status === 'failed' || !started.providerRef) { fail('Vapi refused to start the call (check the key, phone number id and assistant id)'); }
  else {
    ok(`call started (${started.providerRef}); waiting for it to end (up to 5 minutes)`);
    let call: any = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      call = await voice.getCall(started.providerRef);
      if (call?.status === 'ended') break;
    }
    if (call?.status !== 'ended') warn('the call did not finish in time; run again or check the Vapi dashboard');
    else {
      let p = parseEndOfCall(call, survey);
      console.log(`  INFO  endedReason="${call.endedReason}" -> platform status "${mapEndedReason(call.endedReason, Object.keys(p.answers).length > 0)}", ${p.durationSec}s`);
      console.log(`  INFO  structured data from Vapi: ${JSON.stringify(call.analysis?.structuredData ?? null)}`);
      console.log(`  INFO  answers the platform would keep: ${JSON.stringify(p.answers)}  stop requested: ${p.optOut}`);
      if (call.analysis?.structuredData?.answers === undefined) warn('Vapi returned no "answers" object: the structured data schema was not applied (see docs/vapi-setup.md)');
      else ok('structured data has the expected shape');
      if (!p.costUsdMicros) {
        console.log('  INFO  cost is 0 or missing right now; asking again in 60 seconds (Vapi finalises billing a little later)');
        await new Promise((r) => setTimeout(r, 60_000));
        p = parseEndOfCall((await voice.getCall(started.providerRef)) ?? call, survey);
      }
      if (p.costUsdMicros) ok(`cost reported: US$${(p.costUsdMicros / 1e6).toFixed(4)}`); else warn('no cost reported yet: check the Vapi dashboard, the platform will keep asking');
      if (p.hasRecording) warn('the call has a recording although recording was switched off for it');
      else ok('no recording was kept');
    }
    if (await voice.deleteCall(started.providerRef)) ok('test call deleted at Vapi (the deletion used for retention works)');
    else warn('could not delete the test call at Vapi (retention deletion will not work with this key)');
  }
} else console.log('4. Test call: skipped (add --call +<your number> to place one)');

console.log(`\n${failures ? 'NOT READY' : warnings ? 'READY WITH WARNINGS' : 'READY'}: ${failures} failure(s), ${warnings} warning(s)`);
process.exit(failures ? 1 : 0);
