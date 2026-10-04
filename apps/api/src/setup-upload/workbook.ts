import * as XLSX from 'xlsx';
import { zonedTimeToUtc } from '../common/event-time';
import {
  EMAIL, Issue, RawRow, findSheet, hhmmOf, inFileOrder, isBlank, minutesOf, parseDate, parseTime,
  pick, positiveNumber, readGrid, readSheet, readWorkbook, text, validTimezone, yes,
} from './cells';

export type { Issue } from './cells';
import { LAP_RUBRIC, RatingDimension } from '../scoring-templates/lap-rubric';

/**
 * Reads and checks the interview setup workbook, and works out the schedule
 * it describes.
 *
 * The workbook gives a day template (blocks of interviews, breaks and
 * calibration with their lengths), the judges, and each judge's availability
 * per date and block. From those this builds every day's slots and seats each
 * judge in the interviews they are available for. One panel interviews at a
 * time. Candidates are not part of this workbook; they are placed later.
 *
 * Nothing here touches the database: the same function serves the preview and
 * the import, so what the admin confirms is exactly what gets built.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type EventInfo = {
  name: string;
  location: string | null;
  timezone: string;
  minPanel: number;
  adminEmails: string[];
  /** Asked of every judge as Yes / No, e.g. "Support for LAP". Null for none. */
  supportQuestion: string | null;
  /** Rating rubrics: the finest step a judge may score in (0.25 allows 3.75). */
  scoreStep: number;
};

export type ItemKind = 'INTERVIEW' | 'BREAK' | 'CALIBRATION';

/** One row of the day template, with its times worked out. */
export type TemplateItem = { row: number; block: string; kind: ItemKind; start: number; end: number };

export const TIERS = ['L1', 'L2', 'L3', 'L4', 'PS', 'V'] as const;
export type Tier = (typeof TIERS)[number];

export type JudgeRow = {
  row: number;
  name: string;
  email: string;
  phone: string | null;
  organisation: string | null;
  designation: string | null;
  tier: Tier | null;
};

/** A judge's answer for one date and block: the whole block, or a window in minutes. */
export type Availability = { kind: 'ALL' } | { kind: 'WINDOW'; from: number; to: number };

export type PlannedSlot = {
  kind: ItemKind;
  /** Position in the block, from 1. */
  sequence: number;
  start: string;
  end: string;
  startUtc: Date;
  endUtc: Date;
  /** Judges available for the whole slot. */
  available: string[];
  /** The panel: the available judges, or nobody when fewer than the minimum. Interviews only. */
  panel: string[];
};

export type PlannedBlock = { date: string; block: string; slots: PlannedSlot[] };

export type CriterionRow = {
  row: number;
  name: string;
  parent: string | null;
  maxScore: number;
  guidance: string | null;
  requiresComment: boolean;
};

/** One dimension of a 1-5 rating rubric (the Rubric sheet). */
export type RatingRow = RatingDimension & { row: number; requiresComment: boolean };

export type ParsedWorkbook = {
  event: EventInfo | null;
  template: TemplateItem[];
  judges: JudgeRow[];
  schedule: PlannedBlock[];
  /** Points rubric from the Criteria sheet (hackathon style). */
  criteria: CriterionRow[];
  /** Rating rubric from the Rubric sheet. Neither sheet filled means the LAP rubric. */
  rating: RatingRow[];
};

export type DaySummary = {
  date: string;
  blocks: { block: string; interviews: number; withPanel: number; judges: string[] }[];
};

export type CheckResult = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  summary: {
    eventName: string | null;
    timezone: string | null;
    minPanel: number | null;
    judges: number;
    days: number;
    interviews: number;
    interviewsWithPanel: number;
    blocks: { block: string; start: string; end: string; interviews: number }[];
    schedule: DaySummary[];
    rubric: string;
    supportQuestion: string | null;
    scoreStep: number;
    /** Rating rubrics: how many dimensions need a comment. */
    commentsRequired: number | null;
  };
  workbook: ParsedWorkbook;
};

/** Steps a rating can be scored in: 1 (whole numbers) down to 0.1. */
export const SCORE_STEPS = [1, 0.5, 0.25, 0.1];
export const DEFAULT_SCORE_STEP = 0.25;

/** The rubric total every category must add up to (matches the scoring template). */
export const RUBRIC_TOTAL = 100;

const SHEET_ORDER = ['File', 'Event', 'Day template', 'Judges', 'Availability', 'Rubric', 'Criteria'];

// ─── Availability cells ────────────────────────────────────────────────────

const YES = ['yes', 'y', 'ok', 'available', '✓', '✔', 'true'];
const NO = ['no', 'n', 'x', '-', 'na', 'n/a', 'not available', 'false'];

/**
 * One availability cell. The agreed format is Yes, No (or blank), or a 24-hour
 * window HH:MM-HH:MM. Anything else is refused rather than guessed at: a wrong
 * guess either loses a judge or seats one who isn't there.
 */
export function parseAvailability(v: unknown): Availability | null | 'invalid' {
  if (isBlank(v)) return null;
  if (typeof v === 'boolean') return v ? { kind: 'ALL' } : null;
  const s = String(v).trim().toLowerCase();
  if (YES.includes(s)) return { kind: 'ALL' };
  if (NO.includes(s)) return null;
  const m = s.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);
  if (!m) return 'invalid';
  const from = parseTime(m[1]);
  const to = parseTime(m[2]);
  if (!from || !to || minutesOf(to) <= minutesOf(from)) return 'invalid';
  return { kind: 'WINDOW', from: minutesOf(from), to: minutesOf(to) };
}

function covers(a: Availability, start: number, end: number): boolean {
  return a.kind === 'ALL' || (a.from <= start && end <= a.to);
}

function normaliseKind(v: unknown): ItemKind | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (['interview', 'interviews', 'candidate', 'slot'].includes(s)) return 'INTERVIEW';
  if (s === 'break' || s === 'tea break' || s === 'lunch') return 'BREAK';
  if (s === 'calibration' || s === 'caliberation') return 'CALIBRATION';
  return null;
}

function normaliseTier(v: unknown): Tier | null | 'invalid' {
  const s = text(v)?.toUpperCase();
  if (!s) return null;
  return (TIERS as readonly string[]).includes(s) ? (s as Tier) : 'invalid';
}

// ─── Reading and checking ──────────────────────────────────────────────────

/**
 * Parse and check a setup workbook. Never throws for bad content: everything
 * wrong comes back as an error, so the person uploading sees all of it at once.
 */
export function checkWorkbook(buffer: Buffer): CheckResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (sheet: string, row: number | null, message: string) => errors.push({ sheet, row, message });
  const warn = (sheet: string, row: number | null, message: string) => warnings.push({ sheet, row, message });
  const empty: ParsedWorkbook = { event: null, template: [], judges: [], schedule: [], criteria: [], rating: [] };

  const wb = readWorkbook(buffer);
  if (!wb) {
    err('File', null, 'This file could not be read as an Excel workbook. Save it as .xlsx and try again.');
    return finish(empty, errors, warnings);
  }
  // The candidates file looks similar from the outside. Say what it is rather
  // than listing every setup sheet it doesn't have.
  const isSetup = ['Event', 'Day template', 'Judges', 'Availability'].some((n) => findSheet(wb, n));
  if (!isSetup && findSheet(wb, 'Candidates')) {
    err('File', null, 'This is a candidates file. Upload it on the Schedule page (Upload candidates), after the setup workbook has created the schedule.');
    return finish(empty, errors, warnings);
  }
  const sheet = (name: string, required: boolean): RawRow[] => {
    const rows = readSheet(wb, name);
    if (rows === null) {
      if (required) err(name, null, `The "${name}" sheet is missing. Start from the template so every sheet is there.`);
      return [];
    }
    if (rows.length === 0 && required && name !== 'Event') err(name, null, `The ${name} sheet is empty.`);
    return rows;
  };

  const event = readEvent(sheet('Event', true), wb, err);
  const timezone = event && validTimezone(event.timezone) ? event.timezone : null;
  const template = readTemplate(sheet('Day template', true), err);
  const judges = readJudges(sheet('Judges', true), err);
  const criteria = readCriteria(sheet('Criteria', false), err);
  const rating = readRating(sheet('Rubric', false), err);
  if (criteria.length > 0 && rating.length > 0) {
    err('Rubric', null, 'Both the Rubric and the Criteria sheets are filled in. Use one: Rubric for 1-5 ratings, Criteria for points.');
  }
  // With no rubric at all the event uses the LAP rubric, and its question.
  if (event && criteria.length === 0 && rating.length === 0 && event.supportQuestion === null) {
    event.supportQuestion = LAP_RUBRIC.supportQuestion;
  }

  const schedule: PlannedBlock[] = [];
  const availSheet = findSheet(wb, 'Availability');
  if (!availSheet) {
    err('Availability', null, 'The "Availability" sheet is missing. Start from the template so every sheet is there.');
  } else {
    const blocks = new Map<string, TemplateItem[]>();
    for (const t of template) blocks.set(t.block.toLowerCase(), [...(blocks.get(t.block.toLowerCase()) ?? []), t]);
    const grid = readAvailability(availSheet, blocks, judges, err, warn);
    if (grid && timezone && event) {
      for (const col of grid.columns) {
        const items = blocks.get(col.block.toLowerCase())!;
        const answers = grid.answers.get(col.index) ?? new Map<string, Availability>();
        // A block nobody can sit stays blank: no slots at all.
        if (answers.size === 0) continue;
        const usable = items.some((i) => i.kind === 'INTERVIEW' && [...answers.values()].some((a) => covers(a, i.start, i.end)));
        for (const [email, a] of answers) {
          if (a.kind === 'WINDOW' && !items.some((i) => i.kind === 'INTERVIEW' && covers(a, i.start, i.end))) {
            const name = judges.find((j) => j.email === email)?.name ?? email;
            warn('Availability', grid.rowOf.get(email) ?? null,
              `${name}'s window ${hhmmOf(a.from)}-${hhmmOf(a.to)} on ${col.header} doesn't cover a whole interview, so they won't sit any.`);
          }
        }
        if (!usable) continue;
        const slots: PlannedSlot[] = items.map((item, i) => {
          const available = item.kind === 'INTERVIEW'
            ? [...answers.entries()].filter(([, a]) => covers(a, item.start, item.end)).map(([e]) => e)
            : [];
          const startUtc = zonedTimeToUtc(col.date, Math.floor(item.start / 60), item.start % 60, timezone);
          const endUtc = zonedTimeToUtc(col.date, Math.floor(item.end / 60), item.end % 60, timezone);
          return {
            kind: item.kind,
            sequence: i + 1,
            start: hhmmOf(item.start),
            end: hhmmOf(item.end),
            startUtc,
            endUtc,
            available,
            panel: available.length >= event.minPanel ? available : [],
          };
        });
        const interviews = slots.filter((s) => s.kind === 'INTERVIEW');
        const thin = interviews.filter((s) => s.panel.length === 0).length;
        if (thin > 0) {
          warn('Availability', null,
            `${col.header}: ${thin} of ${interviews.length} interviews have fewer than ${event.minPanel} judges available, so they have no panel.`);
        }
        schedule.push({ date: col.date, block: items[0].block, slots });
      }
      schedule.sort((a, b) => a.slots[0].startUtc.getTime() - b.slots[0].startUtc.getTime());
      if (schedule.length === 0 && !errors.some((e) => e.sheet === 'Availability')) {
        err('Availability', null, 'No judge is available for any block, so there is nothing to schedule.');
      }
    }
  }

  return finish({ event, template, judges, schedule, criteria, rating }, errors, warnings);
}

function readEvent(rows: RawRow[], wb: XLSX.WorkBook, err: (s: string, r: number | null, m: string) => void): EventInfo | null {
  if (rows.length === 0) {
    if (findSheet(wb, 'Event')) err('Event', 2, 'The Event sheet has no event details. Fill in row 2.');
    return null;
  }
  if (rows.length > 1) err('Event', rows[1].row, 'The Event sheet should have one row. Delete the extra rows.');
  const r = rows[0];
  const c = r.cells;
  const name = text(pick(c, 'event_name', 'name'));
  const tz = text(pick(c, 'timezone', 'time_zone')) ?? 'Asia/Singapore';
  const minRaw = pick(c, 'minimum_panel_size', 'min_panel_size', 'minimum_panel');
  const minPanel = minRaw === null ? 2 : positiveNumber(minRaw);
  const admins = (text(pick(c, 'admin_emails', 'admins', 'admin_email')) ?? '')
    .split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

  if (!name) err('Event', r.row, 'Event name is empty.');
  if (!validTimezone(tz)) err('Event', r.row, `"${tz}" is not a timezone this system recognises. Use a name like Asia/Singapore.`);
  if (minPanel === null || !Number.isInteger(minPanel) || minPanel > 10) {
    err('Event', r.row, 'Minimum panel size must be a whole number from 1 to 10, or left blank for 2.');
  }
  for (const a of admins) if (!EMAIL.test(a)) err('Event', r.row, `"${a}" in Admin emails is not an email address.`);
  const stepRaw = pick(c, 'score_step', 'step');
  const step = stepRaw === null ? null : Number(String(stepRaw).trim());
  if (stepRaw !== null && !SCORE_STEPS.includes(step as number)) {
    err('Event', r.row, `Score step must be one of ${SCORE_STEPS.join(', ')} (or blank for ${DEFAULT_SCORE_STEP}).`);
  }
  return {
    name: name ?? '',
    location: text(pick(c, 'location', 'venue')),
    timezone: tz,
    minPanel: minPanel ?? 2,
    adminEmails: [...new Set(admins)],
    supportQuestion: text(pick(c, 'support_question', 'judge_question')),
    scoreStep: step ?? DEFAULT_SCORE_STEP,
  };
}

/**
 * The day template, with each item's start and end worked out. Items in a
 * block follow on one after another from the block's start time; a later row
 * may give its own start time to leave a gap, but never to overlap.
 */
function readTemplate(rows: RawRow[], err: (s: string, r: number | null, m: string) => void): TemplateItem[] {
  const out: TemplateItem[] = [];
  const cursor = new Map<string, number>();
  const names = new Map<string, string>();
  for (const r of rows) {
    const c = r.cells;
    const block = text(pick(c, 'block'));
    const kind = normaliseKind(pick(c, 'item', 'type'));
    const durRaw = pick(c, 'duration', 'duration_minutes', 'minutes');
    const dur = positiveNumber(durRaw);
    const startRaw = pick(c, 'start_time', 'start', 'time');
    const start = parseTime(startRaw);
    if (!block) { err('Day template', r.row, 'Block is empty.'); continue; }
    const key = block.toLowerCase();
    if (!names.has(key)) names.set(key, block);
    if (!kind) { err('Day template', r.row, `Item must be Interview, Break or Calibration.`); continue; }
    if (durRaw === null) { err('Day template', r.row, 'Duration is empty.'); continue; }
    if (dur === null || !Number.isInteger(dur) || dur > 240) { err('Day template', r.row, 'Duration must be a whole number of minutes, up to 240.'); continue; }
    if (startRaw !== null && !start) { err('Day template', r.row, `Start time "${startRaw}" can't be read. Use 24-hour HH:MM, e.g. 09:00.`); continue; }

    let at: number;
    if (!cursor.has(key)) {
      if (!start) { err('Day template', r.row, `The first row of block ${block} needs a start time.`); continue; }
      at = minutesOf(start);
    } else if (start) {
      at = minutesOf(start);
      if (at < cursor.get(key)!) {
        err('Day template', r.row, `Start time ${start} overlaps the previous item in ${block}, which ends at ${hhmmOf(cursor.get(key)!)}.`);
        continue;
      }
    } else {
      at = cursor.get(key)!;
    }
    if (at + dur > 24 * 60) { err('Day template', r.row, `This item runs past midnight.`); continue; }
    out.push({ row: r.row, block: names.get(key)!, kind, start: at, end: at + dur });
    cursor.set(key, at + dur);
  }
  if (rows.length > 0 && out.length === 0) return out;

  const byBlock = new Map<string, TemplateItem[]>();
  for (const t of out) byBlock.set(t.block, [...(byBlock.get(t.block) ?? []), t]);
  for (const [block, items] of byBlock) {
    if (!items.some((i) => i.kind === 'INTERVIEW')) err('Day template', items[0].row, `Block ${block} has no interviews.`);
  }
  const spans = [...byBlock.entries()].map(([block, items]) => ({ block, start: items[0].start, end: items[items.length - 1].end, row: items[0].row }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      err('Day template', spans[i].row, `Block ${spans[i].block} starts at ${hhmmOf(spans[i].start)}, before block ${spans[i - 1].block} ends at ${hhmmOf(spans[i - 1].end)}. One panel can't be in both.`);
    }
  }
  return out;
}

function readJudges(rows: RawRow[], err: (s: string, r: number | null, m: string) => void): JudgeRow[] {
  const judges: JudgeRow[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const c = r.cells;
    const name = text(pick(c, 'name', 'judge_name'));
    const email = text(pick(c, 'email', 'judge_email'))?.toLowerCase() ?? null;
    const tier = normaliseTier(pick(c, 'tier'));
    if (!name) err('Judges', r.row, 'Name is empty.');
    if (!email) { err('Judges', r.row, 'Email is empty. It is how the Availability sheet refers to the judge.'); continue; }
    if (!EMAIL.test(email)) { err('Judges', r.row, `"${email}" is not an email address.`); continue; }
    if (tier === 'invalid') err('Judges', r.row, `Tier must be one of ${TIERS.join(', ')}, or left blank.`);
    if (seen.has(email)) { err('Judges', r.row, `${email} is listed twice (also row ${seen.get(email)}).`); continue; }
    seen.set(email, r.row);
    const phone = pick(c, 'phone', 'mobile');
    judges.push({
      row: r.row,
      name: name ?? email,
      email,
      phone: phone === null ? null : String(phone).trim(),
      organisation: text(pick(c, 'organisation', 'organization')),
      designation: text(pick(c, 'designation', 'title')),
      tier: tier === 'invalid' ? null : tier,
    });
  }
  return judges;
}

type AvailabilityColumn = { index: number; header: string; date: string; block: string };

/**
 * The availability grid: judges down, "YYYY-MM-DD Block" across. Returns,
 * per column, each judge's answer — only judges who said yes or gave a window.
 */
function readAvailability(
  sheet: XLSX.WorkSheet,
  blocks: Map<string, TemplateItem[]>,
  judges: JudgeRow[],
  err: (s: string, r: number | null, m: string) => void,
  warn: (s: string, r: number | null, m: string) => void,
): { columns: AvailabilityColumn[]; answers: Map<number, Map<string, Availability>>; rowOf: Map<string, number> } | null {
  const grid = readGrid(sheet);
  if (grid.length < 2) {
    err('Availability', null, 'The Availability sheet has no judges.');
    return null;
  }
  const header = grid[0] ?? [];
  const columns: AvailabilityColumn[] = [];
  const seenCols = new Map<string, string>();
  for (let j = 1; j < header.length; j++) {
    const raw = header[j];
    if (isBlank(raw)) continue;
    const h = String(raw).trim();
    const m = h.match(/^(.*\S)\s+(\S+)$/);
    const date = m ? parseDate(m[1]) : null;
    const block = m?.[2];
    if (!m || !date) {
      err('Availability', 1, `Column header "${h}" should be a date and block, e.g. 2026-10-19 AM.`);
      continue;
    }
    if (!blocks.has(block!.toLowerCase())) {
      err('Availability', 1, `Column "${h}": block "${block}" is not on the Day template sheet.`);
      continue;
    }
    const key = `${date}|${block!.toLowerCase()}`;
    if (seenCols.has(key)) {
      err('Availability', 1, `Column "${h}" repeats "${seenCols.get(key)}".`);
      continue;
    }
    seenCols.set(key, h);
    columns.push({ index: j, header: h, date, block: blocks.get(block!.toLowerCase())![0].block });
  }
  if (columns.length === 0 && !header.slice(1).some((v) => !isBlank(v))) {
    err('Availability', 1, 'The Availability sheet has no date columns. Add one column per date and block, e.g. 2026-10-19 AM.');
  }

  const known = new Map(judges.map((j) => [j.email, j]));
  const answers = new Map<number, Map<string, Availability>>();
  const rowOf = new Map<string, number>();
  for (let i = 1; i < grid.length; i++) {
    const line = grid[i] ?? [];
    if (line.every(isBlank)) continue;
    const rowNo = i + 1;
    const email = text(line[0])?.toLowerCase();
    if (!email) { err('Availability', rowNo, 'Judge email is empty.'); continue; }
    if (!known.has(email)) { err('Availability', rowNo, `${email} is not on the Judges sheet.`); continue; }
    if (rowOf.has(email)) { err('Availability', rowNo, `${email} has two rows (also row ${rowOf.get(email)}).`); continue; }
    rowOf.set(email, rowNo);
    for (const col of columns) {
      const a = parseAvailability(line[col.index]);
      if (a === 'invalid') {
        err('Availability', rowNo,
          `${known.get(email)!.name}, ${col.header}: "${String(line[col.index]).trim()}" isn't Yes, No or a time window like 13:00-16:00.`);
        continue;
      }
      if (!a) continue;
      const m = answers.get(col.index) ?? new Map<string, Availability>();
      m.set(email, a);
      answers.set(col.index, m);
    }
  }
  for (const j of judges) {
    if (!rowOf.has(j.email)) warn('Judges', j.row, `${j.name} has no row on the Availability sheet, so won't sit any interviews.`);
  }
  return { columns, answers, rowOf };
}

/**
 * The rubric, if one is given. Same rules the scoring template enforces before
 * judges can score: two levels, categories add up to 100, and each category's
 * rows add up to that category's maximum.
 */
function readCriteria(rows: RawRow[], err: (s: string, r: number | null, m: string) => void): CriterionRow[] {
  const out: CriterionRow[] = [];
  const byName = new Map<string, CriterionRow>();
  for (const r of rows) {
    const c = r.cells;
    const name = text(pick(c, 'criterion', 'name'));
    const parent = text(pick(c, 'parent_criterion', 'parent', 'category'));
    const maxRaw = pick(c, 'max_score', 'max');
    const max = positiveNumber(maxRaw);
    if (!name) { err('Criteria', r.row, 'Criterion is empty.'); continue; }
    if (maxRaw === null) { err('Criteria', r.row, 'Max score is empty.'); continue; }
    if (max === null || !Number.isInteger(max)) { err('Criteria', r.row, 'Max score must be a whole number above 0.'); continue; }
    const key = name.toLowerCase();
    if (byName.has(key)) { err('Criteria', r.row, `"${name}" is listed twice (also row ${byName.get(key)!.row}).`); continue; }
    const row: CriterionRow = {
      row: r.row, name, parent, maxScore: max,
      guidance: text(pick(c, 'guidance', 'guidance_text')),
      requiresComment: yes(pick(c, 'comment_required', 'requires_comment')),
    };
    out.push(row);
    byName.set(key, row);
  }
  if (out.length === 0) return out;

  const categories = out.filter((c) => !c.parent);
  for (const c of out) {
    if (!c.parent) continue;
    const p = byName.get(c.parent.toLowerCase());
    if (!p) err('Criteria', c.row, `Parent criterion "${c.parent}" is not listed.`);
    else if (p.parent) err('Criteria', c.row, `"${c.parent}" is itself inside another category. Criteria go two levels deep at most.`);
  }
  if (categories.length === 0) {
    err('Criteria', null, 'There are no categories (rows with no parent criterion).');
    return out;
  }
  const total = categories.reduce((s, c) => s + c.maxScore, 0);
  if (total !== RUBRIC_TOTAL) err('Criteria', null, `Categories add up to ${total}. They must add up to ${RUBRIC_TOTAL}.`);
  for (const cat of categories) {
    const kids = out.filter((c) => c.parent?.toLowerCase() === cat.name.toLowerCase());
    if (kids.length === 0) { err('Criteria', cat.row, `"${cat.name}" has no rows under it. Every category needs at least one row to score.`); continue; }
    const used = kids.reduce((s, k) => s + k.maxScore, 0);
    if (used !== cat.maxScore) err('Criteria', cat.row, `"${cat.name}" allows ${cat.maxScore} points but its rows add up to ${used}.`);
  }
  return out;
}

/**
 * A 1-5 rating rubric: one row per dimension, with what a 1, 3 and 5 look
 * like. Judges see those descriptions while scoring, so all three are needed.
 */
function readRating(rows: RawRow[], err: (s: string, r: number | null, m: string) => void): RatingRow[] {
  const out: RatingRow[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const c = r.cells;
    const name = text(pick(c, 'dimension', 'name'));
    if (!name) { err('Rubric', r.row, 'Dimension is empty.'); continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) { err('Rubric', r.row, `"${name}" is listed twice (also row ${seen.get(key)}).`); continue; }
    seen.set(key, r.row);
    const low = text(pick(c, 'score_1', 'low', '1'));
    const moderate = text(pick(c, 'score_3', 'moderate', '3'));
    const high = text(pick(c, 'score_5', 'high', '5'));
    const missing = [!low && 'Score 1', !moderate && 'Score 3', !high && 'Score 5'].filter(Boolean);
    if (missing.length) { err('Rubric', r.row, `"${name}" needs a description for ${missing.join(', ')}. Judges see these while scoring.`); continue; }
    // Comments are required unless the sheet says N for this dimension.
    const cr = text(pick(c, 'comment_required', 'requires_comment'));
    if (cr !== null && !['y', 'yes', 'n', 'no'].includes(cr.toLowerCase())) {
      err('Rubric', r.row, `Comment required for "${name}" must be Y or N (got "${cr}").`);
    }
    out.push({
      row: r.row, name, descriptor: text(pick(c, 'descriptor', 'description')) ?? '', low: low!, moderate: moderate!, high: high!,
      requiresComment: cr === null || !['n', 'no'].includes(cr.toLowerCase()),
    });
  }
  if (out.length > 0 && out.length < 3) {
    err('Rubric', null, `The rubric has ${out.length} dimension${out.length === 1 ? '' : 's'}. It needs at least 3.`);
  }
  if (out.length > 10) err('Rubric', null, `The rubric has ${out.length} dimensions. Keep it to 10 or fewer.`);
  return out;
}

function finish(wb: ParsedWorkbook, errorsIn: Issue[], warningsIn: Issue[]): CheckResult {
  const errors = inFileOrder(errorsIn, SHEET_ORDER);
  const warnings = inFileOrder(warningsIn, SHEET_ORDER);
  const nameOf = new Map(wb.judges.map((j) => [j.email, j.name]));

  const byDate = new Map<string, DaySummary>();
  let interviews = 0;
  let withPanel = 0;
  for (const b of wb.schedule) {
    const iv = b.slots.filter((s) => s.kind === 'INTERVIEW');
    const seated = iv.filter((s) => s.panel.length > 0);
    interviews += iv.length;
    withPanel += seated.length;
    const judges = [...new Set(seated.flatMap((s) => s.panel))].map((e) => nameOf.get(e) ?? e);
    const day = byDate.get(b.date) ?? { date: b.date, blocks: [] };
    day.blocks.push({ block: b.block, interviews: iv.length, withPanel: seated.length, judges });
    byDate.set(b.date, day);
  }

  const blockSpans = new Map<string, TemplateItem[]>();
  for (const t of wb.template) blockSpans.set(t.block, [...(blockSpans.get(t.block) ?? []), t]);
  const categories = wb.criteria.filter((c) => !c.parent).length;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      eventName: wb.event?.name || null,
      timezone: wb.event?.timezone ?? null,
      minPanel: wb.event?.minPanel ?? null,
      judges: wb.judges.length,
      days: byDate.size,
      interviews,
      interviewsWithPanel: withPanel,
      blocks: [...blockSpans.entries()].map(([block, items]) => ({
        block,
        start: hhmmOf(items[0].start),
        end: hhmmOf(items[items.length - 1].end),
        interviews: items.filter((i) => i.kind === 'INTERVIEW').length,
      })),
      schedule: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      rubric: wb.rating.length > 0
        ? `${wb.rating.length} dimensions rated 1-5`
        : wb.criteria.length > 0
          ? `${categories} categories, ${wb.criteria.length - categories} rows`
          : `LAP rubric, ${LAP_RUBRIC.dimensions.length} dimensions rated 1-5 (Rubric sheet empty)`,
      supportQuestion: wb.event?.supportQuestion ?? null,
      scoreStep: wb.criteria.length > 0 ? 1 : wb.event?.scoreStep ?? DEFAULT_SCORE_STEP,
      commentsRequired: wb.rating.length > 0 ? wb.rating.filter((d) => d.requiresComment).length : wb.criteria.length > 0 ? null : LAP_RUBRIC.dimensions.length,
    },
    workbook: wb,
  };
}
