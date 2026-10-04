import * as path from 'path';
import * as fs from 'fs';
import PDFDocument = require('pdfkit');
import { CandidateRecord, DECISION_LABEL, Decision, ReviewData } from './review.service';

/**
 * The candidate assessment report, as a PDF.
 *
 * Made when HR submits the final decision and stored with it, so the file on
 * record is exactly what was decided. One A4 report per candidate:
 *
 *   header     brand, reference, event
 *   hero       name, interview, panel; HR decision and average
 *   quadrant   HR assessment (left) and the panel profile radar (right),
 *              tinted rose / sand / sage by the average
 *   scores     every judge's score on every dimension, with the average,
 *              and each judge's answer to the support question
 *   comments   every judge's comment, dimension by dimension
 *   basis      how the numbers were worked out
 */

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONTS: Record<string, string> = {
  serif: 'source-serif-4-latin-400-normal.ttf',
  serifBold: 'source-serif-4-latin-600-normal.ttf',
  sans: 'inter-latin-400-normal.ttf',
  sansMedium: 'inter-latin-500-normal.ttf',
  sansBold: 'inter-latin-600-normal.ttf',
  mono: 'ibm-plex-mono-latin-400-normal.ttf',
  monoMedium: 'ibm-plex-mono-latin-500-normal.ttf',
};
let fontBytes: Record<string, Buffer> | null = null;
function fonts(): Record<string, Buffer> {
  if (!fontBytes) {
    fontBytes = Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, fs.readFileSync(path.join(FONT_DIR, f))]));
  }
  return fontBytes;
}

const BRAND = 'Talent Discovery';
const INK = '#1d2230';
const BODY = '#374151';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const RULE = '#d6d9df';
const HAIR = '#eceef2';
const WEB = '#dcd8cf';

const DECISION_COLOUR: Record<Decision, string> = {
  SELECTED: '#3f6a4c',
  WAITLIST: '#8a6a2c',
  NOT_SELECTED: '#8a4b40',
  DID_NOT_ATTEND: '#5b6270',
};

/** Pale rose to sand to sage, by the share of the top score reached. */
const FILL: [number, number[]][] = [[0.4, [229, 193, 184]], [0.6, [234, 219, 184]], [0.8, [195, 214, 198]]];
const LINE: [number, number[]][] = [[0.4, [160, 98, 86]], [0.6, [150, 120, 60]], [0.8, [78, 118, 90]]];

function blend(stops: [number, number[]][], f: number): string {
  let c: number[];
  if (f <= stops[0][0]) c = stops[0][1];
  else if (f >= stops[2][0]) c = stops[2][1];
  else {
    const k = f < stops[1][0] ? 0 : 1;
    const [a, ca] = stops[k];
    const [b, cb] = stops[k + 1];
    const t = (f - a) / (b - a);
    c = ca.map((x, i) => Math.round(x + (cb[i] - x) * t));
  }
  return '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The average's colour: stroke and fill for the radar, and the score text. */
export function scoreTone(average: number | null, max: number) {
  const f = average === null || !max ? 0 : average / max;
  return { fill: blend(FILL, f), line: blend(LINE, f) };
}

export function reportRef(r: CandidateRecord): string {
  return `TD-${r.date.replace(/-/g, '').slice(2)}-${r.sessionId.slice(0, 6).toUpperCase()}`;
}

export function reportFileName(r: CandidateRecord, revision = 1): string {
  const name = r.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'candidate';
  return `${name}-${r.date}-assessment${revision > 1 ? `-rev${revision}` : ''}.pdf`;
}

function longDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

function stamp(d: Date | string | null, tz: string): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(d));
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : String(n));
/** Averages: one decimal for ratings (3.0 of 5), as they are for points. */
let averageFormat: 'POINTS' | 'RATING' = 'POINTS';
const avgFmt = (n: number | null | undefined) =>
  n === null || n === undefined ? '–' : averageFormat === 'RATING' ? n.toFixed(1) : String(n);

type Doc = PDFKit.PDFDocument;

/**
 * preview: HR's draft, not yet submitted. Shows the decision and comments as
 * they stand, marked as a draft on every page, and is never stored.
 */
export async function buildReportPdf(
  data: ReviewData, r: CandidateRecord, printedAt = new Date(),
  opts: {
    preview?: boolean;
    /** The decision's revision; 2 or more after a reopening. */
    revision?: number;
    /** The report this one replaces, named in the footer. */
    replaces?: { revision: number; createdAt: Date } | null;
  } = {},
): Promise<Buffer> {
  const doc: Doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 56, left: 42, right: 42 },
    bufferPages: true,
    info: { Title: `${r.name} — assessment report`, Author: BRAND, Subject: data.event.name },
  });
  for (const [name, bytes] of Object.entries(fonts())) doc.registerFont(name, bytes);
  averageFormat = data.scale;
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Later pages carry the candidate's name, so a loose page can be put back.
  doc.on('pageAdded', () => {
    const top = doc.page.margins.top;
    doc.font('serif').fontSize(9).fillColor(BODY).text(r.name, doc.page.margins.left, 22, { lineBreak: false });
    doc.font('mono').fontSize(7).fillColor(MUTED)
      .text(`Ref ${reportRef(r)}`, doc.page.margins.left, 23.5, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'right', lineBreak: false });
    doc.moveTo(doc.page.margins.left, 35).lineTo(doc.page.width - doc.page.margins.right, 35).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.x = doc.page.margins.left;
    doc.y = top + 8;
  });

  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
  const rating = data.scale === 'RATING';
  const preview = !!opts.preview;
  // In a preview the draft decision is shown as it stands.
  const decided = r.decision?.status === 'SUBMITTED' || preview ? r.decision?.decision ?? null : null;
  const tone = scoreTone(r.average, data.scoreMax);
  const scored = r.judges.filter((j) => j.submitted);
  const tz = data.event.timezone;

  const label = (text: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) => {
    doc.font('monoMedium').fontSize(6.8).fillColor(MUTED)
      .text(text.toUpperCase(), x, y, { characterSpacing: 1.3, lineBreak: false, ...opts });
  };
  const rule = (y: number, colour = RULE, width = 0.6) => {
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(width).strokeColor(colour).stroke();
  };

  // ── Header ────────────────────────────────────────────────────────────
  doc.font('serifBold').fontSize(15).fillColor(INK).text(BRAND, L, 40, { lineBreak: false });
  label('Candidate assessment report', L, 60);
  doc.font('mono').fontSize(8).fillColor(BODY).text(`Ref ${reportRef(r)}`, L, 42, { width: W, align: 'right' });
  doc.font('mono').fontSize(7.5).fillColor('#0f7b4f')
    .text(data.event.name.toUpperCase(), L + W / 3, 54, { width: (W * 2) / 3, align: 'right', characterSpacing: 0.6 });
  rule(76, INK, 0.8);

  // ── Hero ──────────────────────────────────────────────────────────────
  const heroTop = 92;
  const rightW = 170;
  doc.font('serif').fontSize(26).fillColor(INK).text(r.name, L, heroTop, { width: W - rightW - 16 });
  let y = doc.y + 4;
  doc.font('sans').fontSize(9.5).fillColor(BODY).text(`Interviewed ${longDate(r.date)}, ${r.start}–${r.end}`, L, y, { width: W - rightW - 16 });
  y = doc.y + 3;
  const panel = r.judges.filter((j) => !j.excused).map((j) => j.name).join(', ') || 'none';
  doc.font('mono').fontSize(7.8).fillColor(MUTED).text(`Panel · ${panel}`, L, y, { width: W - rightW - 16 });
  const heroLeftEnd = doc.y;

  const rx = L + W - rightW;
  label('HR decision', rx, heroTop + 2, { width: rightW, align: 'right' });
  doc.font('serif').fontSize(19).fillColor(decided ? DECISION_COLOUR[decided] : '#6d28d9')
    .text(decided ? DECISION_LABEL[decided] : 'Pending', rx, heroTop + 13, { width: rightW, align: 'right' });
  doc.font('mono').fontSize(8.5).fillColor(BODY)
    .text(`average ${avgFmt(r.average)} / ${data.scoreMax}`, rx, doc.y + 1, { width: rightW, align: 'right' });
  if (data.supportQuestion) {
    doc.font('mono').fontSize(7.8).fillColor(MUTED)
      .text(`${data.supportQuestion} · ${r.support.yes} of ${scored.length} Yes`, rx, doc.y + 2, { width: rightW, align: 'right' });
  }
  const badge = preview ? 'Draft preview' : decided ? ((opts.revision ?? 1) > 1 ? `Final · revision ${opts.revision}` : 'Final') : 'Not final';
  doc.font('monoMedium').fontSize(6.8);
  const bw = doc.widthOfString(badge.toUpperCase(), { characterSpacing: 1.2 }) + 12;
  const by = doc.y + 5;
  const bColour = preview ? '#6d28d9' : decided ? DECISION_COLOUR[decided] : '#6d28d9';
  doc.rect(L + W - bw, by, bw, 13).lineWidth(0.7).strokeColor(bColour).stroke();
  doc.fillColor(bColour).text(badge.toUpperCase(), L + W - bw, by + 3.5, { width: bw, align: 'center', characterSpacing: 1.2, lineBreak: false });
  y = Math.max(heroLeftEnd, by + 13) + 12;
  rule(y);

  // ── HR assessment (left) and panel profile (right) ───────────────────
  const qTop = y + 14;
  const gap = 22;
  const leftW = Math.round(W * 0.44);
  const radarX = L + leftW + gap;
  const radarW = W - leftW - gap;

  label('HR assessment', L, qTop);
  const feedback = r.decision?.feedback?.trim() || 'No HR comment recorded.';
  doc.font('sans').fontSize(9.6).fillColor(r.decision?.feedback ? INK : MUTED)
    .text(feedback, L + 10, qTop + 15, { width: leftW - 10, lineGap: 2.2 });
  const fbEnd = doc.y;
  doc.moveTo(L + 1, qTop + 14).lineTo(L + 1, fbEnd).lineWidth(2).strokeColor(decided ? DECISION_COLOUR[decided] : RULE).stroke();
  let leftEnd = fbEnd;
  if (preview) {
    doc.font('mono').fontSize(7.5).fillColor('#6d28d9')
      .text('Draft · not yet submitted', L + 10, fbEnd + 6, { width: leftW - 10 });
    leftEnd = doc.y;
  } else if (decided) {
    doc.font('mono').fontSize(7.5).fillColor(MUTED)
      .text(`Decided by ${r.decision?.decidedBy ?? 'unknown'} · ${stamp(r.decision?.decidedAt ?? null, tz)}`, L + 10, fbEnd + 6, { width: leftW - 10 });
    leftEnd = doc.y;
  }

  label(rating ? 'Panel profile' : 'Consolidated score', radarX, qTop);
  const axes = r.categoryAverages.map((c) => ({ name: c.name, value: c.average, max: c.maxScore }));
  let rightEnd: number;
  if (axes.length >= 3) {
    rightEnd = drawRadar(doc, radarX, qTop + 14, radarW, axes, tone, rating ? data.scoreMax : 0);
  } else {
    rightEnd = drawBars(doc, radarX, qTop + 18, radarW, axes);
  }
  doc.moveTo(radarX, rightEnd + 4).lineTo(radarX + radarW, rightEnd + 4).lineWidth(0.5).strokeColor(HAIR).stroke();
  doc.font('sansBold').fontSize(9).fillColor(INK).text('Average', radarX, rightEnd + 10, { lineBreak: false });
  doc.font('sans').fontSize(8).fillColor(MUTED)
    .text(`  of ${scored.length} judge${scored.length === 1 ? '' : 's'}`, { lineBreak: false });
  doc.font('monoMedium').fontSize(9.5).fillColor(tone.line)
    .text(`${avgFmt(r.average)} / ${data.scoreMax}`, radarX, rightEnd + 9.5, { width: radarW, align: 'right' });
  rightEnd += 24;

  doc.x = L;
  doc.y = Math.max(leftEnd, rightEnd) + 16;
  rule(doc.y);
  doc.y += 14;

  // ── Scores table ──────────────────────────────────────────────────────
  drawScores(doc, data, r, L, W, label, ensure);

  // ── Comments ──────────────────────────────────────────────────────────
  doc.y += 16;
  ensure(60);
  label('Panel comments', L, doc.y);
  doc.y += 14;
  if (rating) drawCommentsByDimension(doc, data, r, L, W, ensure, tone);
  else drawCommentsByJudge(doc, data, r, L, W, ensure);

  // ── Basis ─────────────────────────────────────────────────────────────
  doc.y += 14;
  ensure(60);
  label('Basis of assessment', L, doc.y);
  doc.y += 13;
  const excused = r.judges.filter((j) => j.excused);
  const basis = [
    `Each judge assessed the candidate independently against the rubric; their scores and comments appear exactly as submitted.`,
    rating
      ? `Each dimension is rated ${Math.min(...data.criteria.map((c) => c.minScore))} to ${data.scoreMax}. The average is the mean rating of the ${scored.length} submitted scorecard${scored.length === 1 ? '' : 's'}; dimension figures are averaged the same way.`
      : `The average is the mean total of the ${scored.length} submitted scorecard${scored.length === 1 ? '' : 's'}; category figures are averaged the same way.`,
    excused.length ? `${excused.map((j) => j.name).join(', ')} stepped out of this interview and ${excused.length === 1 ? 'is' : 'are'} not counted unless a scorecard was submitted.` : '',
    `The HR decision is the reviewer's, taken with these scores and comments in view. Times are ${tz}.`,
  ].filter(Boolean).join(' ');
  doc.font('sans').fontSize(8).fillColor('#4b5563').text(basis, L, doc.y, { width: W, lineGap: 1.5 });

  // ── Footer on every page ──────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 36;
    if (preview) {
      // Faint, diagonal, on every page: a preview must never pass for the record.
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('serifBold').fontSize(88).fillColor('#6d28d9').fillOpacity(0.06)
        .text('PREVIEW', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center', lineBreak: false });
      doc.restore();
      doc.fillOpacity(1);
    }
    doc.moveTo(L, fy - 7).lineTo(L + W, fy - 7).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font('mono').fontSize(6.5).fillColor(preview ? '#6d28d9' : MUTED).text(
      preview
        ? `DRAFT PREVIEW — NOT THE RECORD · ${reportRef(r)} · ${stamp(printedAt, tz).toUpperCase()} · PAGE ${i - range.start + 1} OF ${range.count}`
        : (opts.revision ?? 1) > 1
          ? `${reportRef(r)} · REVISION ${opts.revision}${opts.replaces ? `, REPLACES REVISION ${opts.replaces.revision} OF ${stamp(opts.replaces.createdAt, tz).toUpperCase()}` : ''} · CONFIDENTIAL · PAGE ${i - range.start + 1} OF ${range.count}`
          : `${reportRef(r)} · CONFIDENTIAL — FOR HIRING DECISIONS ONLY · ${stamp(printedAt, tz).toUpperCase()} · PAGE ${i - range.start + 1} OF ${range.count}`,
      L, fy, { width: W, align: 'center', characterSpacing: 0.8, lineBreak: false },
    );
    doc.page.margins.bottom = saved;
  }

  doc.end();
  return finished;
}

/**
 * The spider web: one shape for the panel's average on each dimension,
 * tinted by the overall average. Returns the y just below it.
 */
function drawRadar(
  doc: Doc, x: number, y: number, w: number,
  axes: { name: string; value: number | null; max: number }[],
  tone: { fill: string; line: string },
  scaleMax: number,
): number {
  const n = axes.length;
  // The left and right labels sit beside the web, so the web shrinks to leave them room.
  const R = Math.min(64, w / 2 - 74);
  const labelW = Math.max(56, w / 2 - R - 10);
  const cx = x + w / 2;
  const cy = y + R + 30;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, r: number): [number, number] => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];

  // Rings at each whole rating (1..5), or every 20% for points.
  const rings = scaleMax > 0 && scaleMax <= 10 ? Array.from({ length: scaleMax }, (_, k) => (k + 1) / scaleMax) : [0.2, 0.4, 0.6, 0.8, 1];
  for (const f of rings) {
    const pts = axes.map((_, i) => pt(i, R * f));
    doc.polygon(...pts).lineWidth(f === 1 ? 0.8 : 0.45).strokeColor(WEB).stroke();
  }
  axes.forEach((_, i) => {
    const [px, py] = pt(i, R);
    doc.moveTo(cx, cy).lineTo(px, py).lineWidth(0.45).strokeColor(WEB).stroke();
  });

  const shape = axes.map((a, i) => pt(i, R * Math.max(0, Math.min(1, (a.value ?? 0) / (a.max || 1)))));
  doc.save();
  doc.polygon(...shape).fillOpacity(0.92).lineWidth(0.9).lineJoin('round').fillAndStroke(tone.fill, tone.line);
  doc.restore();

  let lowest = cy + R;
  axes.forEach((a, i) => {
    const c = Math.cos(angle(i));
    const s = Math.sin(angle(i));
    const [lx, ly] = pt(i, R + 8);
    const align: 'left' | 'right' | 'center' = c > 0.3 ? 'left' : c < -0.3 ? 'right' : 'center';
    const tx = align === 'left' ? lx : align === 'right' ? lx - labelW : lx - labelW / 2;
    doc.font('sans').fontSize(7.6);
    const nameH = doc.heightOfString(a.name, { width: labelW, align });
    const h = nameH + 10;
    const ty = s < -0.9 ? ly - h - 2 : s > 0.3 ? ly + 1 : ly - h / 2;
    doc.fillColor('#3d424d').text(a.name, tx, ty, { width: labelW, align, lineGap: 0 });
    doc.font('mono').fontSize(7.4).fillColor(MUTED)
      .text(a.max ? `${avgFmt(a.value)} / ${a.max}` : avgFmt(a.value), tx, ty + nameH + 0.5, { width: labelW, align });
    lowest = Math.max(lowest, ty + h);
  });
  return lowest + 4;
}

/** For a rubric with fewer than three categories a radar is a line, so: bars. */
function drawBars(doc: Doc, x: number, y: number, w: number, axes: { name: string; value: number | null; max: number }[]): number {
  for (const a of axes) {
    doc.font('sans').fontSize(8.5).fillColor(INK).text(a.name, x, y, { width: w - 60 });
    doc.font('mono').fontSize(8.5).text(`${fmt(a.value)} / ${a.max}`, x, y, { width: w, align: 'right' });
    y = doc.y + 2;
    doc.rect(x, y, w, 3).fill(HAIR);
    doc.rect(x, y, (w * (a.value ?? 0)) / (a.max || 1), 3).fill(INK);
    y += 10;
  }
  return y;
}

function drawScores(
  doc: Doc, data: ReviewData, r: CandidateRecord, L: number, W: number,
  label: (t: string, x: number, y: number, o?: PDFKit.Mixins.TextOptions) => void,
  ensure: (h: number) => void,
) {
  const rating = data.scale === 'RATING';
  const judges = r.judges;
  const scored = judges.filter((j) => j.submitted);
  const colW = Math.min(56, (W * 0.5) / Math.max(1, judges.length + 1));
  const avgW = 50;
  const firstW = W - colW * judges.length - avgW;

  const parents = new Set(data.criteria.map((c) => c.parentId).filter(Boolean));
  const leaves = data.criteria.filter((c) => !parents.has(c.id));
  type Row = { kind: 'cat'; name: string } | { kind: 'row'; id: string; name: string; max: number };
  const rows: Row[] = [];
  if (rating || parents.size === 0) {
    for (const l of leaves) rows.push({ kind: 'row', id: l.id, name: l.name, max: l.maxScore });
  } else {
    for (const cat of data.criteria.filter((c) => !c.parentId && parents.has(c.id))) {
      rows.push({ kind: 'cat', name: cat.name });
      for (const l of data.criteria.filter((c) => c.parentId === cat.id)) rows.push({ kind: 'row', id: l.id, name: l.name, max: l.maxScore });
    }
  }

  ensure(80);
  label(rating ? 'Scores by dimension' : 'Scores by criterion', L, doc.y);
  let y = doc.y + 14;
  const head = (yy: number) => {
    doc.font('monoMedium').fontSize(6.8).fillColor(MUTED);
    doc.text(rating ? 'DIMENSION' : 'CRITERION', L, yy, { width: firstW, characterSpacing: 0.8 });
    judges.forEach((j, k) => doc.text((j.name + (j.excused ? '*' : '')).toUpperCase(), L + firstW + k * colW, yy, { width: colW, align: 'right', characterSpacing: 0.4, lineBreak: false, ellipsis: true }));
    doc.text('AVERAGE', L + firstW + judges.length * colW, yy, { width: avgW, align: 'right', characterSpacing: 0.8 });
    doc.moveTo(L, yy + 11).lineTo(L + W, yy + 11).lineWidth(0.8).strokeColor(INK).stroke();
    return yy + 16;
  };
  y = head(y);

  for (const row of rows) {
    doc.font(row.kind === 'cat' ? 'sansBold' : 'sans').fontSize(8.6);
    const h = doc.heightOfString(row.name, { width: firstW - 8 }) + 7;
    if (y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = head(doc.page.margins.top); }
    if (row.kind === 'cat') {
      doc.fillColor(BODY).text(row.name, L, y + 3, { width: firstW - 8 });
      y += h;
      continue;
    }
    doc.fillColor(INK).text(row.name, L, y + 2, { width: firstW - 8 });
    judges.forEach((j, k) => {
      const v = j.scores[row.id]?.score;
      doc.font('mono').fontSize(8.6).fillColor(j.submitted ? INK : FAINT)
        .text(fmt(v ?? null), L + firstW + k * colW, y + 2, { width: colW, align: 'right' });
    });
    const vals = scored.map((j) => j.scores[row.id]?.score).filter((v): v is number => typeof v === 'number');
    const avg = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    const t = scoreTone(avg, row.max);
    doc.font('monoMedium').fontSize(8.6).fillColor(rating ? t.line : INK)
      .text(`${avgFmt(avg)}`, L + firstW + judges.length * colW, y + 2, { width: avgW, align: 'right' });
    y += h;
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.4).strokeColor(HAIR).stroke();
  }

  // Totals, and the support question.
  const lines: { name: string; cells: string[]; avg: string }[] = [];
  if (rating) {
    lines.push({
      name: `Average rating (out of ${data.scoreMax})`,
      cells: judges.map((j) => {
        if (!j.submitted) return '–';
        const v = leaves.map((l) => j.scores[l.id]?.score ?? 0);
        return avgFmt(Math.round((v.reduce((a, b) => a + b, 0) / (v.length || 1)) * 10) / 10);
      }),
      avg: avgFmt(r.average),
    });
  } else {
    lines.push({ name: `Total (out of ${data.maxTotal})`, cells: judges.map((j) => (j.submitted ? fmt(j.total) : '–')), avg: fmt(r.average) });
  }
  if (data.supportQuestion) {
    lines.push({
      name: data.supportQuestion,
      cells: judges.map((j) => (j.support === true ? 'Yes' : j.support === false ? 'No' : '–')),
      avg: `${r.support.yes} of ${scored.length}`,
    });
  }
  if (y + 20 * lines.length > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = head(doc.page.margins.top); }
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.8).strokeColor(INK).stroke();
  for (const line of lines) {
    doc.font('sansBold').fontSize(8.6).fillColor(INK).text(line.name, L, y + 4, { width: firstW - 8 });
    line.cells.forEach((c, k) => doc.font('monoMedium').fontSize(8.6).text(c, L + firstW + k * colW, y + 4, { width: colW, align: 'right' }));
    doc.font('monoMedium').fontSize(8.6).text(line.avg, L + firstW + judges.length * colW, y + 4, { width: avgW, align: 'right' });
    y += 17;
  }
  if (judges.some((j) => j.excused)) {
    doc.font('sans').fontSize(7.5).fillColor(MUTED).text('* stepped out of this interview', L, y + 2);
    y = doc.y;
  }
  doc.x = L;
  doc.y = y;
}

/** Rating rubrics: each dimension, then every judge's rating and comment on it. */
function drawCommentsByDimension(
  doc: Doc, data: ReviewData, r: CandidateRecord, L: number, W: number,
  ensure: (h: number) => void, _tone: { fill: string; line: string },
) {
  const parents = new Set(data.criteria.map((c) => c.parentId).filter(Boolean));
  const leaves = data.criteria.filter((c) => !parents.has(c.id));
  const nameW = 84;
  // Room for a quarter score (3.75) in the chip.
  const chipW = 26;
  const textX = L + nameW + chipW + 10;
  const textW = W - (textX - L);
  for (const l of leaves) {
    const avg = r.categoryAverages.find((c) => c.id === l.id)?.average ?? null;
    // Keep a dimension's comments together when they fit on a page.
    doc.font('sans').fontSize(9);
    const block = 28 + r.judges.reduce((h, j) => {
      const c = j.scores[l.id]?.comment?.trim() || '—';
      return h + Math.max(doc.heightOfString(c, { width: textW, lineGap: 1.6 }), 12) + 6;
    }, 0);
    ensure(Math.min(block, 360));
    doc.font('serifBold').fontSize(10.5).fillColor(INK).text(l.name, L, doc.y, { width: W - 90 });
    const headY = doc.y - 13;
    doc.font('mono').fontSize(8).fillColor(MUTED).text(`average ${avgFmt(avg)} / ${l.maxScore}`, L, headY + 2, { width: W, align: 'right' });
    doc.y += 3;
    for (const j of r.judges) {
      const s = j.scores[l.id];
      if (!j.submitted && !s?.comment) continue;
      const comment = s?.comment?.trim() || '—';
      doc.font('sans').fontSize(9);
      const h = Math.max(doc.heightOfString(comment, { width: textW, lineGap: 1.6 }), 12) + 6;
      ensure(h);
      const y = doc.y;
      doc.font('sans').fontSize(8.4).fillColor(MUTED).text(j.name, L, y + 1, { width: nameW, lineBreak: false, ellipsis: true });
      if (typeof s?.score === 'number') {
        const t = scoreTone(s.score, l.maxScore);
        doc.roundedRect(L + nameW, y, chipW, 13, 3).fill(t.fill);
        doc.font('monoMedium').fontSize(8.4).fillColor(t.line).text(String(s.score), L + nameW, y + 2.6, { width: chipW, align: 'center', lineBreak: false });
      }
      doc.font('sans').fontSize(9).fillColor(INK).text(comment, textX, y + 0.5, { width: textW, lineGap: 1.6 });
      doc.y = Math.max(doc.y, y + 13) + 5;
    }
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.4).strokeColor(HAIR).stroke();
    doc.y += 9;
  }
}

/** Points rubrics: each judge's summary, then their criterion comments. */
function drawCommentsByJudge(doc: Doc, data: ReviewData, r: CandidateRecord, L: number, W: number, ensure: (h: number) => void) {
  for (const j of r.judges) {
    ensure(60);
    const y0 = doc.y;
    doc.font('serifBold').fontSize(10.5).fillColor(INK).text(j.name + (j.excused ? ' (stepped out)' : ''), L, y0, { width: W - 160 });
    doc.font('mono').fontSize(8).fillColor(BODY).text(j.submitted ? `${j.total} / ${data.maxTotal}` : 'not submitted', L, y0 + 2, { width: W, align: 'right' });
    doc.y = Math.max(doc.y, y0 + 14) + 2;
    for (const [k, v] of [['Strengths', j.strengths], ['Areas for improvement', j.areasForImprovement], ['Recommendation', j.recommendation]] as const) {
      if (!v) continue;
      doc.font('sans').fontSize(9);
      const h = doc.heightOfString(v, { width: W - 130 }) + 4;
      ensure(h);
      const y = doc.y;
      doc.font('sans').fontSize(8.4).fillColor(MUTED).text(k, L, y, { width: 120 });
      doc.font('sans').fontSize(9).fillColor(INK).text(v, L + 130, y, { width: W - 130 });
      doc.y = Math.max(doc.y, y + 11) + 2;
    }
    for (const c of data.criteria) {
      const cm = j.scores[c.id]?.comment;
      if (!cm) continue;
      const t = `${c.name} — “${cm}”`;
      doc.font('sans').fontSize(8.6);
      ensure(doc.heightOfString(t, { width: W - 12 }) + 3);
      doc.fillColor(BODY).text(t, L + 12, doc.y, { width: W - 12 });
      doc.y += 2;
    }
    doc.moveTo(L, doc.y + 3).lineTo(L + W, doc.y + 3).lineWidth(0.4).strokeColor(HAIR).stroke();
    doc.y += 10;
  }
}
