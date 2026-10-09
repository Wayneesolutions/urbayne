// node docs/gen-gap-report.cjs  (run from the repo root; uses pdfkit from apps/api)
const path = require('path');
const PDFDocument = require(require.resolve('pdfkit', { paths: [path.join(__dirname, '../apps/api')] }));
const fs = require('fs');

const OUT = path.join(__dirname, 'Campaign_Suite_Kya_Bana_Kya_Baaki.pdf');
const NAVY = '#1E2240', INK = '#26203F', SOFT = '#5B5575', LINE = '#D9DBE8';
const COL = { DONE: '#2F7D5B', PART: '#B97C00', NO: '#B54A2C', EXT: '#5B5575' };
const LABEL = { DONE: 'BANA', PART: 'AADHA', NO: 'NAHI BANA', EXT: 'BAHAR KA KAAM' };

// [item, status, note]
const SECTIONS = [
  ['1. Aath tools ka status (PDF section 01)', [
    ['Tool 1: Voter info hub (IN + CA)', 'PART', 'Page, language buttons, read-aloud, share links, QR bane hain. Recorded audio, self-hosted fonts, French/Tagalog ab bane hain. Baaki: IN ka missed-call se entry (sirf database mein naam hai, koi flow nahi).'],
    ['Tool 2: AI campaign assistant (web)', 'DONE', 'Sirf approved content se jawab, voting ke sawal official link par, French/Tagalog bhi.'],
    ['Tool 2: Phone helpline Punjabi/Hindi (IN)', 'PART', 'Constituent-service ke liye Vapi helpline bani hai. Campaign ke assistant ke liye alag phone helpline nahi bani.'],
    ['Tool 2: SMS channel (CA)', 'PART', 'Inbound SMS service tickets ke liye hai. Assistant se SMS par sawal-jawab nahi bana.'],
    ['Tool 3: AI voice calls aur surveys', 'PART', 'Poora code, per-call compliance check, evidence pack bane hain. Asli call kabhi nahi lagi: Vapi/DLT live account se test baaki.'],
    ['Tool 4: Booth worker / canvassing app', 'PART', 'Offline app, map view, roll se household import bane hain. Photo notes nahi bane. PDF roll se text extraction nahi.'],
    ['Tool 5: Workers, rallies, lawn signs', 'PART', 'Events, permissions, shifts, DLT reminders, sign routes (road routing ke saath) bane hain. Alag "vehicle log" nahi bana (sirf vehicle event + permission).'],
    ['Tool 6: Expenditure / campaign finance', 'PART', 'Receipt photo upload, bank reconciliation, filing export bane hain. Official filing layouts DRAFT hain: asli form se confirm baaki.'],
    ['Tool 7: Poll day / election night results', 'DONE', 'Phase 3 mein bana (PR #8). Details section 3 mein.'],
    ['Tool 8: Constituent service platform', 'DONE', 'Phase 3 mein bana (PR #8). Details section 3 mein.'],
  ]],
  ['2. P0: pehli live campaign se pehle (PDF section 03)', [
    ['P0-1 SMS OTP provider (Twilio CA, DLT IN)', 'DONE', 'Code bana. Asli provider account se test nahi hua.'],
    ['P0-2 Redis + BullMQ (call runs, reminders, reports)', 'DONE', 'Row locking ke saath. Redis ke 8 tests is machine par skip hue (Redis nahi tha); CI mein chalte hain.'],
    ['P0-3 Redis-backed rate limits aur sessions', 'DONE', ''],
    ['P0-4 India DLT SMS adapter + template flow', 'DONE', 'MSG91 adapter docs se likha, mocked tests. Asli account se test baaki.'],
    ['P0-5 Vapi live verification', 'PART', 'Adapter docs se check kiya aur ek verify script hai. Asli call kabhi nahi lagi.'],
    ['P0-6 Call cost finance mein', 'DONE', ''],
    ['P0-7 Evidence pack signed PDF', 'DONE', 'Seal (SHA-256 + HMAC) hai. Yeh sarkari/CA digital signature nahi hai.'],
    ['P0-8 Paper/IVR consent + election ke baad data delete', 'DONE', 'Ek purana bug is baar theek hua (door-visit wale campaign ka purge fail hota tha).'],
    ['P0-9 Production infra (Terraform per region)', 'PART', 'Likha aur terraform validate pass. AWS par plan/apply kabhi nahi hua.'],
    ['P0-10 Observability (Sentry, logs, cost dashboard)', 'DONE', ''],
    ['P0-11 Security pass', 'PART', 'Review, fixes, audit clean. Bahar ki penetration test baaki.'],
    ['P0-12 Legal sign-off (calling hours, disclosure, consent, contracts)', 'EXT', 'Code se nahi hota: wakil/counsel ka kaam. Jab tak values set nahi, sends blocked rehte hain.'],
  ]],
  ['3. Phase 3 (PDF section 04)', [
    ['Tool 7: agent reporting (phone link / SMS keyword, booth codes)', 'DONE', ''],
    ['Tool 7: India turnout by booth, counting round-wise vs ECI', 'DONE', 'Official figures team haath se ya CSV se daalti hai. Kisi sarkari system se connection nahi (guardrail).'],
    ['Tool 7: Canada scrutineer counts vs City unofficial results', 'DONE', ''],
    ['Tool 7: duplicates, "campaign reported" labels, archive, load test', 'DONE', 'Load test script scripts/load-test-results.mjs.'],
    ['Tool 8: ticket intake web + SMS + Punjabi/Hindi voice helpline', 'DONE', 'Voice ke liye Vapi helpline setup docs/vapi-setup.md mein.'],
    ['Tool 8: area-wise assignment, SMS status, acknowledgement', 'DONE', ''],
    ['Tool 8: monthly reports aur "work done" export', 'DONE', ''],
    ['Tool 8: monthly subscription billing', 'DONE', 'Phase 5 mein packages ke saath badhaya.'],
  ]],
  ['4. Phase 4 (PDF section 05)', [
    ['Maps with real tiles + road routing (turfs, signs)', 'DONE', 'Leaflet + OSRM. Tile provider aur routing server lagana hai (OpenStreetMap ka public server sirf halke use ke liye). Turf ke liye road routing nahi (households ka coordinate nahi).'],
    ['Household import from electoral roll copies (PDF/Excel) + source proof', 'PART', 'Excel/CSV bana. PDF proof ban jati hai, par PDF se households khud nahi padhe jaate (haath se daalne padte hain).'],
    ['Pre-recorded audio pipeline Punjabi/Hindi, self-hosted fonts, lighter page', 'DONE', 'Audio upload hoti hai (browser mein record nahi). Consent ka sentence abhi phone ki awaaz mein.'],
    ['Official filing formats for finance registers', 'PART', 'System bana. Layouts DRAFT jab tak election agent / City asli form se confirm na kare.'],
    ['Receipt photo upload (S3 in-region) + bank statement reconciliation', 'DONE', 'S3 bucket Terraform mein, validate pass, apply nahi. Real bank ke CSV se test nahi.'],
    ['Multi-campaign agency view (white-label)', 'PART', 'Bana. Agency ka logo image, voter page / PDF par white-label, custom domain nahi.'],
    ['French (Canada) + Tagalog voter-page content', 'PART', 'Bana. Native speaker ka review baaki. Dashboard sirf English/Punjabi/Hindi.'],
  ]],
  ['5. Phase 5', [
    ['India: Punjab Vidhan Sabha 2027 package', 'DONE', 'Draft content, survey, checklist. 117 seats ki list nahi.'],
    ['India: Punjabi/Hindi pitch deck', 'PART', 'Pehla draft docs/pitch mein. Slides dekhi nahi gayi, translation review baaki.'],
    ['India: MCMC workflow with first clients', 'PART', 'Software ka MCMC certificate flow pehle se tha, checklist mein jodha. Clients ke saath asli process tumhara kaam.'],
    ['Canada: Manitoba 2027 package + provincial rules', 'PART', 'Bana. Spending/contribution limit aur blackout jaan-boojhkar khaali: Elections Manitoba se bharne hain.'],
    ['Mobile app wrappers (Android first)', 'PART', 'Capacitor scaffold apps/mobile mein. APK/AAB kabhi build nahi hua (Android SDK nahi).'],
    ['Pricing, metering, invoicing per campaign', 'PART', 'Packages, limits, invoicing, plan editor bane. Asli prices daalne baaki, payment collection aur GST/HST invoice format nahi.'],
  ]],
  ['6. "Kya karna hai ab" list (PDF section 06)', [
    ['1. Demo server deploy karke candidates ko dikhana', 'NO', 'Deploy nahi hua. Handover document ka section 05A.'],
    ['2. P0 items 1-7 aur 9-10 parallel', 'DONE', 'Code level par ho gaye.'],
    ['3. Pehla live pilot (friendly candidate / sitting MLA)', 'NO', 'Abhi koi live pilot nahi.'],
    ['4. Phase 3 pehle (constituent service)', 'DONE', ''],
    ['5. Phase 4-5 Punjab 2027 aur Manitoba 2027 tak', 'PART', 'Upar ki tables dekho.'],
    ['Guardrails: no WhatsApp, no caste/religion, no bought data, no deepfakes, one client per race', 'DONE', 'CI guardrail + code mein lage hain (roll import caste/religion column refuse karta hai).'],
  ]],
];

const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Campaign Suite: kya bana, kya baaki', Author: 'Claude Code' } });
doc.pipe(fs.createWriteStream(OUT));
const W = doc.page.width - 80;

// summary counts
const count = { DONE: 0, PART: 0, NO: 0, EXT: 0 };
for (const [, rows] of SECTIONS) for (const r of rows) count[r[1]]++;

doc.rect(0, 0, doc.page.width, 150).fill(NAVY);
doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(26).text('Campaign Suite: kya bana, kya baaki', 40, 45, { width: W });
doc.font('Helvetica').fontSize(12).fillColor('#CADCFC').text('Roadmap PDF (Sept 2026) ke har item ka status, GitHub code (branch feat/phase4-5, PR #9) ke hisaab se', 40, 95, { width: W });
doc.fillColor('#E8A317').fontSize(11).text('Tayyar: 9 Oct 2026', 40, 125);
doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('Ek nazar mein', 40, 175);
const total = Object.values(count).reduce((a, b) => a + b, 0);
const cardY = 200;
let x = 40;
for (const k of ['DONE', 'PART', 'NO', 'EXT']) {
  doc.roundedRect(x, cardY, 120, 62, 6).fill('#F6F7FB');
  doc.fillColor(COL[k]).font('Helvetica-Bold').fontSize(24).text(String(count[k]), x + 12, cardY + 8, { width: 100, lineBreak: false });
  doc.fillColor(INK).font('Helvetica').fontSize(10).text(LABEL[k], x + 12, cardY + 42, { width: 100, lineBreak: false });
  x += 128;
}
doc.fillColor(SOFT).font('Helvetica').fontSize(10).text(`Kul ${total} items. "BANA" ka matlab: code likha aur tests/checks se dekha. Isse yeh nahi nikalta ki asli providers (Vapi, MSG91, Twilio, AWS) ke saath live test hua hai: woh alag baaki hai jahan likha hai.`, 40, cardY + 76, { width: W });
doc.y = cardY + 118;

doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Sabse zaroori baaki cheezein');
doc.font('Helvetica').fontSize(10.5).fillColor(INK);
for (const t of [
  'Asli provider test: Vapi ki ek asli call, MSG91 DLT ka ek asli SMS, Twilio OTP. Jab tak yeh nahi, "Tool 3" aur SMS live nahi kehlayenge.',
  'Legal sign-off (P0-12): calling hours, AI disclosure wording, consent text, retention days. Isse pehle live sends blocked hain (yeh design hai).',
  'Official filing forms aur Manitoba ke limits: asli form/figures chahiye, guess nahi kiye.',
  'Demo server deploy aur pehla live pilot: abhi koi nahi.',
  'Chhote buildable items: IN missed-call entry, canvasser photo notes, vehicle log, assistant ka SMS channel (CA), campaign ki phone helpline, PDF roll extraction (sirf text-wale PDF ke liye).',
  'Review chahiye: French, Tagalog aur pitch deck ke translations (native speaker).',
]) { doc.text('-  ' + t, { width: W, indent: 0 }); doc.moveDown(0.25); }

for (const [title, rows] of SECTIONS) {
  doc.addPage();
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(title, 40, 40, { width: W });
  doc.moveDown(0.6);
  for (const [item, st, note] of rows) {
    const h = doc.heightOfString(item, { width: 250, fontSize: 10.5 }) ;
    const hn = note ? doc.heightOfString(note, { width: W - 20, fontSize: 9.5 }) : 0;
    const need = Math.max(h, 14) + hn + 16;
    if (doc.y + need > doc.page.height - 50) doc.addPage();
    const y = doc.y;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(item, 40, y, { width: 340 });
    const after = doc.y;
    doc.fillColor(COL[st]).font('Helvetica-Bold').fontSize(10).text(LABEL[st], 400, y, { width: W - 360, align: 'right' });
    doc.y = after;
    if (note) doc.fillColor(SOFT).font('Helvetica').fontSize(9.5).text(note, 40, doc.y + 1, { width: W });
    doc.moveDown(0.35);
    doc.moveTo(40, doc.y).lineTo(40 + W, doc.y).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.moveDown(0.45);
  }
}
doc.end();
console.log('wrote', OUT);
