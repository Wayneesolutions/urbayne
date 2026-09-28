/**
 * Seeds two DEMO campaigns (India + Canada) with areas, approved content,
 * surveys, contacts and share links. Demo tenants always use simulated
 * channels: nobody is ever dialled.
 *
 *   DATABASE_URL=... PHONE_ENC_KEY=... PHONE_HASH_KEY=... pnpm --filter @cs/api seed:demo
 */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { inArray } from 'drizzle-orm';
import { schema } from '@cs/db';
import { IN, CA } from '@cs/regions';
import { renderDisclosure } from '@cs/compliance';
import { encrypt, hashPhone } from '../lib/crypto.js';
import { shortCode } from '../lib/util.js';

const url = process.env.DATABASE_URL;
const ENC = process.env.PHONE_ENC_KEY;
const HASH = process.env.PHONE_HASH_KEY;
if (!url || !ENC || !HASH) throw new Error('DATABASE_URL, PHONE_ENC_KEY and PHONE_HASH_KEY are required');

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool, { schema });
const SLUGS = ['demo-ludhiana', 'demo-winnipeg-ward3'];

async function user(phone: string, name: string) {
  const phoneHash = hashPhone(phone, HASH!);
  const [u] = await db.insert(schema.users).values({ phoneHash, phoneEnc: encrypt(phone, ENC!), name })
    .onConflictDoUpdate({ target: schema.users.phoneHash, set: { name } }).returning();
  return u!;
}

async function main() {
  // Idempotent: remove previous demo tenants (cascades to their data).
  await db.delete(schema.auditLog).where(inArray(schema.auditLog.tenantId,
    (await db.select({ id: schema.tenants.id }).from(schema.tenants).where(inArray(schema.tenants.slug, SLUGS))).map((x) => x.id).concat(['00000000-0000-0000-0000-000000000000'])));
  await db.delete(schema.tenants).where(inArray(schema.tenants.slug, SLUGS));

  const inOwner = await user('+919999900001', 'Demo Manager (India)');
  const caOwner = await user('+12045550001', 'Demo Manager (Canada)');

  // ---------------- INDIA ----------------
  const [tin] = await db.insert(schema.tenants).values({
    region: 'IN', raceType: 'assembly', seatCode: 'DEMO-LDH-WEST', electionDate: '2027-02-20',
    campaignName: 'Gurpreet Kaur', candidateName: 'Gurpreet Kaur', slug: 'demo-ludhiana',
    tagline: 'ਸਾਫ਼ ਪਾਣੀ, ਚੰਗੀਆਂ ਸੜਕਾਂ, ਨੌਜਵਾਨਾਂ ਲਈ ਕੰਮ।',
    timeZone: 'Asia/Kolkata', pollCloseAt: new Date('2027-02-20T18:00:00+05:30'),
    officialInfoUrl: 'https://electoralsearch.eci.gov.in/',
    enabledModules: ['hub', 'assistant', 'calls'], isDemo: true,
    // DEMO VALUE ONLY. Live India calling hours stay blocked until confirmed with provider and counsel.
    callingHoursOverride: { weekday: { start: 9 * 60, end: 21 * 60 }, weekend: { start: 10 * 60, end: 20 * 60 } },
  }).returning();
  await db.insert(schema.memberships).values({ tenantId: tin!.id, userId: inOwner.id, role: 'owner' });

  const [cons] = await db.insert(schema.geoAreas).values({ tenantId: tin!.id, level: 'constituency', code: 'LDH-W', nameEn: 'Ludhiana West (demo)', namePa: 'ਲੁਧਿਆਣਾ ਪੱਛਮੀ', nameHi: 'लुधियाना पश्चिम' }).returning();
  const inAreas = await db.insert(schema.geoAreas).values([
    ['Sarabha Nagar', 'ਸਰਾਭਾ ਨਗਰ', 'सराभा नगर'], ['Model Town', 'ਮਾਡਲ ਟਾਊਨ', 'मॉडल टाउन'], ['Rajguru Nagar', 'ਰਾਜਗੁਰੂ ਨਗਰ', 'राजगुरु नगर'],
    ['Dugri', 'ਦੁੱਗਰੀ', 'दुगरी'], ['Pakhowal Road', 'ਪੱਖੋਵਾਲ ਰੋਡ', 'पखोवाल रोड'], ['Haibowal', 'ਹੈਬੋਵਾਲ', 'हैबोवाल'],
  ].map(([en, pa, hi]) => ({ tenantId: tin!.id, parentId: cons!.id, level: 'locality', nameEn: en!, namePa: pa, nameHi: hi }))).returning();

  const approved = { status: 'approved' as const, approvedBy: inOwner.id, approvedAt: new Date() };
  const certified = (n: number) => ({ status: 'certified' as const, certificateNo: `DEMO-MCMC-${String(n).padStart(4, '0')}`, approvedBy: inOwner.id, approvedAt: new Date() });

  await db.insert(schema.contentItems).values([
    { tenantId: tin!.id, kind: 'page', locale: 'pa', title: 'ਹਰ ਘਰ ਸਾਫ਼ ਪਾਣੀ', body: 'ਪਹਿਲੇ ਸਾਲ ਵਿੱਚ ਹਰ ਮੁਹੱਲੇ ਵਿੱਚ ਪਾਣੀ ਦੀ ਜਾਂਚ ਹੋਵੇਗੀ। ਪੁਰਾਣੀਆਂ ਪਾਈਪਾਂ ਬਦਲੀਆਂ ਜਾਣਗੀਆਂ ਅਤੇ ਹਰ ਹਫ਼ਤੇ ਪਾਣੀ ਦੀ ਰਿਪੋਰਟ ਜਨਤਕ ਹੋਵੇਗੀ।', ...approved },
    { tenantId: tin!.id, kind: 'page', locale: 'pa', title: 'ਨੌਜਵਾਨਾਂ ਲਈ ਕੰਮ', body: 'ਹਰ ਵਾਰਡ ਵਿੱਚ ਹੁਨਰ ਕੇਂਦਰ, ਅਤੇ ਸਥਾਨਕ ਉਦਯੋਗਾਂ ਨਾਲ ਅਪ੍ਰੈਂਟਿਸਸ਼ਿਪ।', ...approved },
    { tenantId: tin!.id, kind: 'page', locale: 'pa', geoAreaId: inAreas[0]!.id, title: 'ਸਰਾਭਾ ਨਗਰ ਲਈ', body: 'ਮਾਰਕੀਟ ਵਾਲੀ ਸੜਕ ਦੀ ਮੁਰੰਮਤ ਅਤੇ ਪਾਰਕਿੰਗ ਦੀ ਨਵੀਂ ਯੋਜਨਾ।', ...approved },
    { tenantId: tin!.id, kind: 'page', locale: 'pa', geoAreaId: inAreas[3]!.id, title: 'ਦੁੱਗਰੀ ਲਈ', body: 'ਸੀਵਰੇਜ ਦਾ ਕੰਮ ਪੂਰਾ ਕਰਨਾ ਅਤੇ ਬੱਚਿਆਂ ਲਈ ਨਵਾਂ ਪਾਰਕ।', ...approved },
    { tenantId: tin!.id, kind: 'page', locale: 'hi', title: 'हर घर साफ़ पानी', body: 'पहले साल में हर मोहल्ले में पानी की जाँच होगी। पुरानी पाइपें बदली जाएँगी और हर हफ़्ते पानी की रिपोर्ट सार्वजनिक होगी।', ...approved },
    { tenantId: tin!.id, kind: 'page', locale: 'hi', title: 'युवाओं के लिए काम', body: 'हर वार्ड में कौशल केंद्र, और स्थानीय उद्योगों के साथ अप्रेंटिसशिप।', ...approved },
    { tenantId: tin!.id, kind: 'page', locale: 'en', title: 'Clean water for every home', body: 'In the first year, water in every locality will be tested. Old pipes will be replaced and a weekly water report will be made public.', ...approved },
    { tenantId: tin!.id, kind: 'page', locale: 'en', title: 'Work for young people', body: 'A skills centre in every ward, and apprenticeships with local industry.', ...approved },
    { tenantId: tin!.id, kind: 'faq', locale: 'pa', title: 'ਪਾਣੀ ਦੀ ਸਮੱਸਿਆ', body: 'ਪਹਿਲੇ ਸਾਲ ਹਰ ਮੁਹੱਲੇ ਵਿੱਚ ਪਾਣੀ ਦੀ ਜਾਂਚ, ਪੁਰਾਣੀਆਂ ਪਾਈਪਾਂ ਬਦਲਣਾ, ਅਤੇ ਹਫ਼ਤਾਵਾਰੀ ਪਾਣੀ ਰਿਪੋਰਟ।', ...approved },
    { tenantId: tin!.id, kind: 'faq', locale: 'pa', title: 'ਨਸ਼ਾ ਅਤੇ ਨੌਜਵਾਨ', body: 'ਹਰ ਵਾਰਡ ਵਿੱਚ ਖੇਡ ਮੈਦਾਨ ਅਤੇ ਹੁਨਰ ਕੇਂਦਰ, ਅਤੇ ਨਸ਼ਾ ਛੁਡਾਊ ਕੇਂਦਰਾਂ ਨਾਲ ਸਿੱਧਾ ਸੰਪਰਕ।', ...approved },
    { tenantId: tin!.id, kind: 'faq', locale: 'pa', title: 'ਉਮੀਦਵਾਰ ਨੂੰ ਕਿਵੇਂ ਮਿਲੀਏ', body: 'ਹਰ ਸ਼ਨੀਵਾਰ ਸਵੇਰੇ 10 ਤੋਂ 1 ਵਜੇ ਤੱਕ ਦਫ਼ਤਰ ਵਿੱਚ ਜਨਤਾ ਦਰਬਾਰ।', ...approved },
    { tenantId: tin!.id, kind: 'faq', locale: 'en', title: 'Water problem', body: 'Water testing in every locality in the first year, replacing old pipes, and a weekly public water report.', ...approved },
    { tenantId: tin!.id, kind: 'faq', locale: 'en', title: 'Drugs and young people', body: 'A playground and skills centre in every ward, with direct links to de-addiction centres.', ...approved },
    { tenantId: tin!.id, kind: 'faq', locale: 'en', title: 'How to meet the candidate', body: 'Public meeting at the office every Saturday, 10 am to 1 pm.', ...approved },
    { tenantId: tin!.id, kind: 'ad', locale: 'pa', title: 'WhatsApp share message', body: 'ਆਪਣੇ ਇਲਾਕੇ ਦੀ ਯੋਜਨਾ ਸੁਣੋ ਅਤੇ ਆਪਣੀ ਸਮੱਸਿਆ ਦੱਸੋ:', ...certified(2) },
  ]);

  const [inScript] = await db.insert(schema.contentItems).values({
    tenantId: tin!.id, kind: 'script', locale: 'pa', title: 'ਮੁੱਦਿਆਂ ਬਾਰੇ ਸਰਵੇ',
    body: `${IN.aiDisclosure.spoken.pa} ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ, ਗੁਰਪ੍ਰੀਤ ਕੌਰ ਦੀ ਟੀਮ ਤੁਹਾਡੇ ਇਲਾਕੇ ਦੇ ਮੁੱਦੇ ਜਾਣਨਾ ਚਾਹੁੰਦੀ ਹੈ। ਸਿਰਫ਼ ਦੋ ਸਵਾਲ ਹਨ।`,
    survey: [
      { key: 'top_issue', question: 'ਤੁਹਾਡੇ ਇਲਾਕੇ ਦਾ ਸਭ ਤੋਂ ਵੱਡਾ ਮੁੱਦਾ ਕੀ ਹੈ?', options: [
        { value: 'water', label: 'ਪਾਣੀ', dtmf: '1' }, { value: 'roads', label: 'ਸੜਕਾਂ', dtmf: '2' }, { value: 'jobs', label: 'ਨੌਕਰੀਆਂ', dtmf: '3' },
        { value: 'drugs', label: 'ਨਸ਼ਾ', dtmf: '4' }, { value: 'sanitation', label: 'ਸਫ਼ਾਈ', dtmf: '5' },
      ] },
      { key: 'attend_sabha', question: 'ਕੀ ਤੁਸੀਂ ਆਪਣੇ ਇਲਾਕੇ ਦੀ ਸਭਾ ਵਿੱਚ ਆਉਣਾ ਚਾਹੋਗੇ?', options: [
        { value: 'yes', label: 'ਹਾਂ', dtmf: '1' }, { value: 'maybe', label: 'ਸ਼ਾਇਦ', dtmf: '2' }, { value: 'no', label: 'ਨਹੀਂ', dtmf: '3' },
      ] },
    ],
    ...certified(1),
  }).returning();

  const inPhones = Array.from({ length: 120 }, (_, i) => `+9199999${String(10000 + i).padStart(5, '0')}`);
  await seedContacts(tin!.id, inPhones, inAreas.map((a) => a.id), 'pa');
  await db.insert(schema.shareLinks).values(['Booth 12 – Harjit', 'Booth 27 – Simran', 'Posters – Model Town'].map((label, i) => ({
    tenantId: tin!.id, code: shortCode(), label, geoAreaId: inAreas[i]!.id, workerUserId: inOwner.id, clicks: [34, 21, 58][i]!, signups: [9, 6, 14][i]!,
  })));

  // ---------------- CANADA ----------------
  const [tca] = await db.insert(schema.tenants).values({
    region: 'CA', raceType: 'ward', seatCode: 'DEMO-WPG-WARD3', electionDate: '2026-10-28',
    campaignName: 'Alex Martin for Ward 3', candidateName: 'Alex Martin', slug: 'demo-winnipeg-ward3',
    tagline: 'Safer streets, faster snow clearing, a council that answers the phone.',
    timeZone: 'America/Winnipeg', pollCloseAt: new Date('2026-10-28T20:00:00-05:00'),
    officialInfoUrl: 'https://www.winnipeg.ca/election2026', enabledModules: ['hub', 'assistant', 'calls'], isDemo: true,
  }).returning();
  await db.insert(schema.memberships).values({ tenantId: tca!.id, userId: caOwner.id, role: 'owner' });
  const [ward] = await db.insert(schema.geoAreas).values({ tenantId: tca!.id, level: 'ward_root', nameEn: 'Ward 3 (demo)' }).returning();
  const caAreas = await db.insert(schema.geoAreas).values(['Maples', 'Garden City', 'Tyndall Park', 'Amber Trails', 'Mandalay West']
    .map((n) => ({ tenantId: tca!.id, parentId: ward!.id, level: 'neighbourhood', nameEn: n }))).returning();
  const caApproved = { status: 'approved' as const, approvedBy: caOwner.id, approvedAt: new Date() };
  await db.insert(schema.contentItems).values([
    { tenantId: tca!.id, kind: 'page', locale: 'en', title: 'Faster snow clearing', body: 'Publish a live snow-clearing map for Ward 3 and push for residential streets to be cleared within 36 hours of a major snowfall.', ...caApproved },
    { tenantId: tca!.id, kind: 'page', locale: 'en', title: 'Safer streets', body: 'Traffic calming near every school in the ward, and better lighting on transit routes.', ...caApproved },
    { tenantId: tca!.id, kind: 'page', locale: 'en', geoAreaId: caAreas[0]!.id, title: 'For the Maples', body: 'Fix the flooding at the underpass and add a crosswalk on the main route to the school.', ...caApproved },
    { tenantId: tca!.id, kind: 'page', locale: 'pa', title: 'ਬਰਫ਼ ਦੀ ਤੇਜ਼ ਸਫ਼ਾਈ', body: 'ਵਾਰਡ 3 ਲਈ ਬਰਫ਼ ਸਫ਼ਾਈ ਦਾ ਲਾਈਵ ਨਕਸ਼ਾ, ਅਤੇ ਵੱਡੀ ਬਰਫ਼ਬਾਰੀ ਤੋਂ 36 ਘੰਟਿਆਂ ਵਿੱਚ ਗਲੀਆਂ ਦੀ ਸਫ਼ਾਈ ਦੀ ਮੰਗ।', ...caApproved },
    { tenantId: tca!.id, kind: 'faq', locale: 'en', title: 'Snow clearing', body: 'Alex will push for a live snow-clearing map and residential streets cleared within 36 hours of a major snowfall.', ...caApproved },
    { tenantId: tca!.id, kind: 'faq', locale: 'en', title: 'Property taxes', body: 'Alex supports keeping any property tax increase at or below inflation and publishing a line-by-line ward budget.', ...caApproved },
    { tenantId: tca!.id, kind: 'faq', locale: 'en', title: 'Meet Alex', body: 'Alex holds open office hours every Saturday, 10 am to noon, at the Maples community centre.', ...caApproved },
    { tenantId: tca!.id, kind: 'ad', locale: 'en', title: 'Share message', body: 'See Alex Martin\'s plan for your street and tell us what matters to you:', ...caApproved },
  ]);
  await db.insert(schema.contentItems).values({
    tenantId: tca!.id, kind: 'script', locale: 'en', title: 'Issue survey',
    body: `${renderDisclosure({ region: CA, tenant: { campaignName: 'Alex Martin for Ward 3' } as never }, 'en')} We have two quick questions about your neighbourhood.`,
    survey: [
      { key: 'top_issue', question: 'What matters most on your street?', options: [
        { value: 'snow', label: 'Snow clearing', dtmf: '1' }, { value: 'safety', label: 'Safety', dtmf: '2' }, { value: 'taxes', label: 'Property taxes', dtmf: '3' }, { value: 'transit', label: 'Transit', dtmf: '4' },
      ] },
      { key: 'lawn_sign', question: 'Would you like a lawn sign?', options: [{ value: 'yes', label: 'Yes', dtmf: '1' }, { value: 'no', label: 'No', dtmf: '2' }] },
    ],
    ...caApproved,
  });
  const caPhones = Array.from({ length: 100 }, (_, i) => `+120455501${String(i).padStart(2, '0')}`);
  await seedContacts(tca!.id, caPhones, caAreas.map((a) => a.id), 'en');
  await db.insert(schema.shareLinks).values(['Door hangers – Maples', 'Volunteer – Priya'].map((label, i) => ({
    tenantId: tca!.id, code: shortCode(), label, geoAreaId: caAreas[i]!.id, workerUserId: caOwner.id, clicks: [41, 17][i]!, signups: [11, 4][i]!,
  })));

  await seedPhase2(tin!, tca!, inOwner.id, caOwner.id, inAreas.map((a) => a.id), caAreas.map((a) => a.id));

  console.log('Demo seeded.');
  console.log(`  India : /v/demo-ludhiana   login ${'+919999900001'}   script ${inScript!.id}`);
  console.log(`  Canada: /v/demo-winnipeg-ward3   login ${'+12045550001'}`);
  console.log('  Worker app: /w   India worker +919999900002, Canada canvasser +12045550002');
  await pool.end();
}

/** Phase 2 demo data: workers, area lists, visits, events, volunteers, finance, signs. All values are demo values. */
async function seedPhase2(tin: typeof schema.tenants.$inferSelect, tca: typeof schema.tenants.$inferSelect, inOwnerId: string, caOwnerId: string, inAreaIds: string[], caAreaIds: string[]) {
  const results = ['supporter', 'supporter', 'undecided', 'not_home', 'supporter', 'not_interested', 'undecided', 'needs_help'] as const;
  const day = (d: number, h = 11) => new Date(Date.now() - d * 86_400_000 + (h - 11) * 3_600_000);

  for (const [t, ownerId, areaIds, workerPhone, workerName, region] of [
    [tin, inOwnerId, inAreaIds, '+919999900002', 'Harjit Singh (demo worker)', 'IN'],
    [tca, caOwnerId, caAreaIds, '+12045550002', 'Priya (demo canvasser)', 'CA'],
  ] as const) {
    const worker = await user(workerPhone, workerName);
    await db.insert(schema.memberships).values({ tenantId: t.id, userId: worker.id, role: 'field_worker' });
    const turfs = await db.insert(schema.turfs).values(areaIds.slice(0, 4).map((geoAreaId, i) => ({
      tenantId: t.id, geoAreaId, name: `Area list ${i + 1}`, assignedUserId: i < 2 ? worker.id : ownerId,
    }))).returning();
    for (const turf of turfs) {
      const people = await db.select().from(schema.contacts).where(inArray(schema.contacts.geoAreaId, [turf.geoAreaId]));
      const visited = people.slice(0, Math.ceil(people.length * 0.7));
      if (visited.length) await db.insert(schema.doorVisits).values(visited.map((c, i) => ({
        tenantId: t.id, turfId: turf.id, contactId: c.id, result: region === 'CA' && i % 9 === 4 ? 'wants_sign' as const : results[i % results.length]!,
        workerId: turf.assignedUserId, visitedAt: day(i % 5), clientUuid: crypto.randomUUID(),
      })));
    }
    const volunteers = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(inArray(schema.contacts.geoAreaId, areaIds)).limit(12);
    const events = await db.insert(schema.events).values(region === 'IN' ? [
      { tenantId: t.id, kind: 'sabha' as const, title: 'ਮਾਡਲ ਟਾਊਨ ਸਭਾ', geoAreaId: areaIds[1], location: 'Community hall', startsAt: day(-3, 17), permissionStatus: 'granted' as const, permissionRef: 'DEMO/SUV/0412', status: 'confirmed' as const },
      { tenantId: t.id, kind: 'rally' as const, title: 'Bike rally, Pakhowal Road', geoAreaId: areaIds[4], startsAt: day(-6, 10), permissionStatus: 'applied' as const },
      { tenantId: t.id, kind: 'door_knock' as const, title: 'Door-to-door, Dugri', geoAreaId: areaIds[3], startsAt: day(-1, 9), permissionStatus: 'not_needed' as const, status: 'confirmed' as const },
      { tenantId: t.id, kind: 'sabha' as const, title: 'Sarabha Nagar nukkad sabha', geoAreaId: areaIds[0], startsAt: day(5, 18), permissionStatus: 'granted' as const, permissionRef: 'DEMO/SUV/0377', status: 'done' as const, costMinor: 1_845_000 },
    ] : [
      { tenantId: t.id, kind: 'door_knock' as const, title: 'Saturday door-knock, Maples', geoAreaId: areaIds[0], startsAt: day(-2, 10), permissionStatus: 'not_needed' as const, status: 'confirmed' as const },
      { tenantId: t.id, kind: 'meeting' as const, title: 'Coffee with Alex, Garden City', geoAreaId: areaIds[1], location: 'Library room', startsAt: day(-4, 19), permissionStatus: 'not_needed' as const, status: 'confirmed' as const },
      { tenantId: t.id, kind: 'office_hours' as const, title: 'Campaign launch', startsAt: day(7, 18), permissionStatus: 'not_needed' as const, status: 'done' as const, costMinor: 64_000 },
    ]).returning();
    const [shift] = await db.insert(schema.shifts).values({ tenantId: t.id, eventId: events[0]!.id, title: region === 'IN' ? 'Setup and chairs' : 'Door-knock team', startsAt: events[0]!.startsAt, needed: 8 }).returning();
    await db.insert(schema.shiftAssignments).values(volunteers.slice(0, 5).map((v) => ({ tenantId: t.id, shiftId: shift!.id, contactId: v.id })));
    const done = events.find((e) => e.status === 'done')!;
    await db.insert(schema.financeEntries).values({
      tenantId: t.id, kind: 'expense', entryDate: done.startsAt.toISOString().slice(0, 10), amountMinor: done.costMinor!, category: region === 'IN' ? 'Public meeting / rally' : 'Events',
      description: `${done.title} (from events)`, partyName: 'See event bills', source: 'event', sourceRef: done.id, flags: [{ code: 'MISSING_BILL', message: 'No bill or invoice number recorded.' }], createdBy: ownerId,
    });
  }

  // India: 40 lakh limit, demo rate list and expenses (one priced below the list, one without a bill).
  await db.update(schema.tenants).set({ spendLimitMinor: 4_000_000_00 }).where(inArray(schema.tenants.id, [tin.id]));
  const rates = await db.insert(schema.rateList).values([
    { tenantId: tin.id, item: 'Chair (per day)', unit: 'chair', rateMinor: 1_000 },
    { tenantId: tin.id, item: 'Shamiana / tent (per day)', unit: 'tent', rateMinor: 250_000 },
    { tenantId: tin.id, item: 'Car with driver (per day)', unit: 'vehicle', rateMinor: 250_000 },
    { tenantId: tin.id, item: 'Loudspeaker set (per day)', unit: 'set', rateMinor: 150_000 },
    { tenantId: tin.id, item: 'Poster, A2 colour', unit: 'poster', rateMinor: 1_200 },
  ]).returning();
  await db.insert(schema.financeEntries).values([
    { tenantId: tin.id, kind: 'expense', entryDate: day(9).toISOString().slice(0, 10), amountMinor: 3_600_000, category: 'Printing and posters', description: 'Poster, A2 colour', partyName: 'Guru Nanak Printers', billNo: 'GNP/1182', quantity: '3000', unitRateMinor: 1_200, rateListId: rates[4]!.id, paymentMode: 'bank', flags: [], createdBy: inOwnerId },
    { tenantId: tin.id, kind: 'expense', entryDate: day(6).toISOString().slice(0, 10), amountMinor: 1_500_000, category: 'Vehicles', description: 'Car with driver (per day)', partyName: 'Sidhu Travels', billNo: 'ST-221', quantity: '10', unitRateMinor: 150_000, rateListId: rates[2]!.id, paymentMode: 'upi',
      flags: [{ code: 'BELOW_RATE_LIST', message: 'Rate is below the district rate list; observers may value it at the list rate.' }], createdBy: inOwnerId },
    { tenantId: tin.id, kind: 'expense', entryDate: day(4).toISOString().slice(0, 10), amountMinor: 4_250_000, category: 'Advertising (print, electronic, social media)', description: 'Social media ads (MCMC-certified creatives)', partyName: 'Meta Platforms', billNo: 'FB-88311', paymentMode: 'card', flags: [], createdBy: inOwnerId },
    { tenantId: tin.id, kind: 'expense', entryDate: day(2).toISOString().slice(0, 10), amountMinor: 900_000, category: 'Campaign workers', description: 'Worker meals, 3 days', partyName: 'Local dhaba', paymentMode: 'cash', flags: [{ code: 'MISSING_BILL', message: 'No bill or invoice number recorded.' }], createdBy: inOwnerId },
  ]);

  // Canada: demo limits, contributions, signs around the Maples.
  await db.update(schema.tenants).set({ spendLimitMinor: 2_500_000, contributionLimitMinor: 75_000, officeLat: 49.945, officeLng: -97.195 }).where(inArray(schema.tenants.id, [tca.id]));
  await db.insert(schema.financeEntries).values([
    { tenantId: tca.id, kind: 'contribution', entryDate: day(12).toISOString().slice(0, 10), amountMinor: 50_000, category: 'Individual', description: 'Contribution', partyName: 'Jordan Reyes', paymentMode: 'card', eligibleAttested: true, receiptNo: 'R-0001', flags: [], createdBy: caOwnerId },
    { tenantId: tca.id, kind: 'contribution', entryDate: day(10).toISOString().slice(0, 10), amountMinor: 25_000, category: 'Individual', description: 'Contribution', partyName: 'Maria Santos', paymentMode: 'bank', eligibleAttested: true, receiptNo: 'R-0002', flags: [], createdBy: caOwnerId },
    { tenantId: tca.id, kind: 'contribution', entryDate: day(3).toISOString().slice(0, 10), amountMinor: 50_000, category: 'Individual', description: 'Contribution', partyName: 'Jordan Reyes', paymentMode: 'card', eligibleAttested: false, receiptNo: 'R-0003',
      flags: [{ code: 'ELIGIBILITY_NOT_CONFIRMED', message: 'Contributor eligibility has not been confirmed.' }, { code: 'OVER_CONTRIBUTION_LIMIT', message: 'This contributor would exceed the per-contributor limit.' }], createdBy: caOwnerId },
    { tenantId: tca.id, kind: 'expense', entryDate: day(8).toISOString().slice(0, 10), amountMinor: 420_000, category: 'Signs', description: '200 lawn signs', partyName: 'Prairie Print Co.', billNo: 'PP-5541', paymentMode: 'card', flags: [], createdBy: caOwnerId },
    { tenantId: tca.id, kind: 'expense', entryDate: day(5).toISOString().slice(0, 10), amountMinor: 185_000, category: 'Printing', description: 'Door hangers', partyName: 'Prairie Print Co.', billNo: 'PP-5560', paymentMode: 'card', flags: [], createdBy: caOwnerId },
  ]);
  const streets = ['Jefferson Ave', 'Adsum Dr', 'Mandalay Dr', 'Garden Grove Dr', 'Meadowlark Blvd', 'Castlebury Meadows Dr', 'Ritchie St', 'Leila Ave'];
  await db.insert(schema.signs).values(streets.map((st, i) => ({
    tenantId: tca.id, address: `${120 + i * 17} ${st} (demo)`, lat: 49.94 + ((i * 37) % 11) * 0.0045, lng: -97.21 + ((i * 53) % 13) * 0.0042, status: i === 7 ? 'placed' as const : 'requested' as const,
  })));
}

/** Most contacts consented; a few without consent and a few opted out, so the compliance gates show up in demos. */
async function seedContacts(tenantId: string, phones: string[], areaIds: string[], locale: string) {
  const first = ['Harjit', 'Simran', 'Amandeep', 'Rajinder', 'Navneet', 'Gurdeep', 'Manpreet', 'Kuldeep', 'Jaspreet', 'Baljit', 'Sarah', 'Michael', 'Priya', 'Jordan', 'Maria'];
  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i]!;
    const [c] = await db.insert(schema.contacts).values({
      tenantId, phoneHash: hashPhone(phone, HASH!), phoneEnc: encrypt(phone, ENC!), name: `${first[i % first.length]} (demo)`,
      geoAreaId: areaIds[i % areaIds.length], source: 'form', optedOut: i % 29 === 7, tags: i % 4 === 0 ? ['volunteer'] : ['updates'],
    }).returning();
    if (i % 17 === 5) continue; // no consent: these will be blocked by the compliance engine
    await db.insert(schema.consents).values((['info', 'survey', 'reminder'] as const).flatMap((purpose) => (['voice', 'sms'] as const).map((channel) => ({
      tenantId, contactId: c!.id, purpose, channel, textVersion: 'public-form-v1', locale, capturedVia: 'form',
    }))));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
