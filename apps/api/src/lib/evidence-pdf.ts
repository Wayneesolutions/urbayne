import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => require.resolve(`@fontsource/${pkg}/files/${file}.woff`);

const FONTS = {
  latin: font('noto-sans', 'noto-sans-latin-400-normal'),
  bold: font('noto-sans', 'noto-sans-latin-700-normal'),
  deva: font('noto-sans-devanagari', 'noto-sans-devanagari-devanagari-400-normal'),
  guru: font('noto-sans-gurmukhi', 'noto-sans-gurmukhi-gurmukhi-400-normal'),
};

/** What the PDF needs from the evidence pack (the same object that is hashed and sealed). */
export interface EvidencePack {
  generatedAt: string;
  campaign: { name: string; region: string; seat?: string | null; electionDate?: string | null; demo: boolean };
  run: { id: string; name: string; purpose: string; status: string; startedAt?: string | Date | null; completedAt?: string | Date | null };
  content?: {
    title: string; locale: string; text: string; status: string; certificateNo?: string | null; approvedAt?: string | Date | null;
    survey?: { key: string; question: string }[] | null;
  } | null;
  runGate?: { allowed?: boolean; reasons?: { code: string; message: string }[]; warnings?: { code: string; message: string }[] } | null;
  results: {
    status: string; counts: Record<string, number>; total: number; optOuts: number; followUps: number; avgDurationSec: number;
    blockedReasons: Record<string, number>;
    survey: { key: string; question: string; options: { value: string; label: string; count: number }[] }[];
  };
  auditTrail: { action: string; at: string | Date; actor?: string | null }[];
}

export interface SealInfo { id: string; sha256: string; signature: string; verifyUrl: string }

type Face = 'latin' | 'bold' | 'deva' | 'guru';
const DEVA = String.raw`[ऀ-ॿ]`;
const GURU = String.raw`[਀-੿]`;
const SCRIPT = new RegExp(String.raw`(${DEVA}+(?:\s+${DEVA}+)*)|(${GURU}+(?:\s+${GURU}+)*)`);

/** Splits text into runs so Hindi / Punjabi words use a font that has the letters; spaces stay with the previous run. */
export function scriptRuns(s: string, base: 'latin' | 'bold' = 'latin'): { face: Face; text: string }[] {
  const out: { face: Face; text: string }[] = [];
  for (const part of s.split(new RegExp(SCRIPT.source, 'g'))) {
    if (!part) continue;
    const face: Face = /[ऀ-ॿ]/.test(part) ? 'deva' : /[਀-੿]/.test(part) ? 'guru' : base;
    const last = out[out.length - 1];
    if (last && last.face === face) last.text += part;
    else out.push({ face, text: part });
  }
  return out;
}

const fmt = (d?: string | Date | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'not recorded');
const label = (s: string) => s.replace(/_/g, ' ');

export function renderEvidencePdf(pack: EvidencePack, seal: SealInfo): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 54, bottom: 60, left: 54, right: 54 }, bufferPages: true,
      info: { Title: `Evidence pack: ${pack.run.name}`, Author: 'Campaign Technology Suite', Subject: `Seal ${seal.id}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const [k, v] of Object.entries(FONTS)) doc.registerFont(k, v);

    const W = doc.page.width - 108;
    const write = (s: string, opts: { size?: number; base?: 'latin' | 'bold'; color?: string; gap?: number; indent?: number } = {}) => {
      const runs = scriptRuns(s, opts.base ?? 'latin');
      doc.fillColor(opts.color ?? '#111111').fontSize(opts.size ?? 10);
      const x = 54 + (opts.indent ?? 0);
      runs.forEach((r, i) => {
        // fontkit crashes on the Noto Gurmukhi 'abvm' (above-base mark) positioning table, so it is switched off for that script.
        const o = { continued: i < runs.length - 1, width: W - (opts.indent ?? 0), features: r.face === 'guru' ? { abvm: false } : undefined } as unknown as PDFKit.Mixins.TextOptions;
        if (i === 0) doc.font(r.face).text(r.text, x, doc.y, o);
        else doc.font(r.face).text(r.text, o);
      });
      if (opts.gap !== 0) doc.moveDown(opts.gap ?? 0.4);
    };
    const h = (s: string) => { doc.moveDown(0.6); write(s, { size: 13, base: 'bold', color: '#0b3d2e', gap: 0.2 }); doc.moveTo(54, doc.y).lineTo(54 + W, doc.y).strokeColor('#bbbbbb').lineWidth(0.5).stroke(); doc.moveDown(0.4); };
    const row = (k: string, v: string) => write(`${k}: ${v}`, { indent: 6, gap: 0.15 });

    write('Campaign Technology Suite', { size: 9, color: '#666666', gap: 0.1 });
    write('Evidence pack: AI voice call run', { size: 20, base: 'bold', gap: 0.3 });
    if (pack.campaign.demo) write('DEMO CAMPAIGN: every call in this document was SIMULATED. No real person was called.', { size: 11, base: 'bold', color: '#b00020', gap: 0.5 });

    h('Campaign and run');
    row('Campaign', pack.campaign.name);
    row('Region', `${pack.campaign.region}${pack.campaign.seat ? ` · seat ${pack.campaign.seat}` : ''}${pack.campaign.electionDate ? ` · election ${pack.campaign.electionDate}` : ''}`);
    row('Run', `${pack.run.name} (${pack.run.id})`);
    row('Purpose / status', `${pack.run.purpose} / ${pack.run.status}`);
    row('Started', fmt(pack.run.startedAt));
    row('Completed', fmt(pack.run.completedAt));
    row('Generated', fmt(pack.generatedAt));

    h('Approved content and certificate');
    if (pack.content) {
      row('Title / language', `${pack.content.title} / ${pack.content.locale}`);
      row('Approval status', pack.content.status);
      row('Certificate number', pack.content.certificateNo ?? (pack.campaign.region === 'IN' ? 'NOT RECORDED' : 'not applicable (owner approval)'));
      row('Approved at', fmt(pack.content.approvedAt));
      write('Script read to every person (starts with the AI disclosure):', { size: 9, color: '#555555', gap: 0.2, indent: 6 });
      write(pack.content.text, { indent: 12, gap: 0.5 });
    } else write('No content record found.', { indent: 6 });

    h('Rules check before the run started');
    const gate = pack.runGate;
    if (!gate) write('No gate result stored for this run.', { indent: 6 });
    else {
      row('Result', gate.allowed ? 'ALLOWED' : 'BLOCKED');
      for (const r of gate.reasons ?? []) row('Blocked', `${r.code}: ${r.message}`);
      for (const r of gate.warnings ?? []) row('Warning', `${r.code}: ${r.message}`);
      if (!(gate.reasons?.length) && !(gate.warnings?.length)) row('Details', 'No blocks or warnings.');
    }
    write('Each call was also re-checked right before it was placed (consent, opt-out, calling hours, silence window).', { size: 9, color: '#555555', indent: 6 });

    h('Results');
    const res = pack.results;
    row('Total contacts in run', String(res.total));
    for (const [k, v] of Object.entries(res.counts)) row(label(k), String(v));
    row('Said stop (removed from all future calls)', String(res.optOuts));
    row('Asked for a callback', String(res.followUps));
    row('Average call length', `${res.avgDurationSec} seconds`);
    for (const [k, v] of Object.entries(res.blockedReasons)) row(`Blocked before calling: ${k}`, String(v));
    for (const q of res.survey) {
      doc.moveDown(0.3);
      write(q.question, { base: 'bold', indent: 6, gap: 0.15 });
      for (const o of q.options) row(`  ${o.label}`, String(o.count));
    }

    h('Audit trail');
    if (!pack.auditTrail.length) write('No audit entries for this run.', { indent: 6 });
    for (const a of pack.auditTrail) row(fmt(a.at), `${a.action}${a.actor ? ` by ${a.actor}` : ''}`);

    h('Seal');
    row('Seal ID', seal.id);
    row('SHA-256 of the evidence data', seal.sha256);
    row('Signature (HMAC-SHA256)', seal.signature);
    row('Verify', seal.verifyUrl);
    write('The seal proves this document was generated by the system and that the data behind it has not changed since. It is not a government-issued certificate. Check calling hours, disclosure wording and the evidence format with your counsel before filing.', { size: 8, color: '#555555', indent: 6 });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // otherwise writing the footer inside the bottom margin adds a blank page
      doc.font('latin').fontSize(8).fillColor('#888888').text(`Seal ${seal.id.slice(0, 8)} · page ${i + 1} of ${range.count}`, 54, doc.page.height - 40, { width: W, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}
