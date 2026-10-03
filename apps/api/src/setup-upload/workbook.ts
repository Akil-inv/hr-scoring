import * as XLSX from 'xlsx';
import { zonedTimeToUtc } from '../common/event-time';

/**
 * Reads and checks the event setup workbook.
 *
 * One workbook describes a whole event: rooms, teams, judges, the scoring
 * rubric and the finished schedule. This file turns it into plain data and
 * lists every problem by sheet and row. It never touches the database, so the
 * same checks run for the preview and again, unchanged, just before the
 * import commits.
 *
 * Problems come in two kinds. An error means the event cannot be built as
 * described (a session names a judge who is not on the Judges sheet). A
 * warning means it can, but someone should look (a session with one judge).
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type Issue = { sheet: string; row: number | null; message: string };

export type EventInfo = {
  name: string;
  location: string | null;
  timezone: string;
  sessionMinutes: number;
  adminEmails: string[];
};

export type RoomRow = { row: number; name: string; location: string | null; hasVideo: boolean };

export type TeamRow = {
  row: number;
  name: string;
  projectName: string;
  track: string | null;
  country: string | null;
  organisation: string | null;
  leadName: string;
  leadEmail: string;
  mode: 'IN_PERSON' | 'VIRTUAL';
  problemStatement: string | null;
  solutionSummary: string | null;
};

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

export type SessionRow = {
  row: number;
  /** Local calendar date in the event's timezone, YYYY-MM-DD. */
  date: string;
  /** Local wall-clock times, HH:MM. */
  start: string;
  end: string;
  startUtc: Date;
  endUtc: Date;
  room: string;
  team: string;
  judgeEmails: string[];
};

export type CriterionRow = {
  row: number;
  name: string;
  parent: string | null;
  maxScore: number;
  guidance: string | null;
  requiresComment: boolean;
};

export type ParsedWorkbook = {
  event: EventInfo | null;
  rooms: RoomRow[];
  teams: TeamRow[];
  judges: JudgeRow[];
  sessions: SessionRow[];
  criteria: CriterionRow[];
};

export type DaySummary = { date: string; sessions: number; judges: number; teams: number };

export type CheckResult = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  summary: {
    eventName: string | null;
    timezone: string | null;
    rooms: number;
    tracks: string[];
    teams: number;
    judges: number;
    sessions: number;
    days: DaySummary[];
    rubric: string;
  };
  workbook: ParsedWorkbook;
};

/** More sessions than this for one judge on one day draws a warning. */
export const HEAVY_DAY_SESSIONS = 8;

/** The rubric total every category must add up to (matches the scoring template). */
export const RUBRIC_TOTAL = 100;

const MAX_JUDGES_PER_SESSION = 5;

// ─── Cell helpers ──────────────────────────────────────────────────────────

/**
 * Header text to a stable key: lowercase, no asterisks, punctuation or extra
 * spaces. "Session length (minutes) *" and "session length minutes" both
 * become "session_length_minutes".
 */
export function headerKey(header: unknown): string {
  return String(header ?? '')
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

type RawRow = { row: number; cells: Record<string, unknown> };

/**
 * A sheet as rows of {header key → raw cell value}, with the spreadsheet row
 * number kept so every message can point at the exact line. Rows with nothing
 * in them are skipped.
 */
function readSheet(wb: XLSX.WorkBook, name: string): RawRow[] | null {
  const actual = wb.SheetNames.find((n) => n.trim().toLowerCase() === name.toLowerCase());
  if (!actual) return null;
  const sheet = wb.Sheets[actual];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  if (grid.length === 0) return [];
  const headers = (grid[0] ?? []).map(headerKey);
  const rows: RawRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const line = grid[i] ?? [];
    const cells: Record<string, unknown> = {};
    let any = false;
    headers.forEach((h, j) => {
      if (!h) return;
      const v = line[j];
      if (v !== null && v !== undefined && String(v).trim() !== '') any = true;
      cells[h] = v;
    });
    if (any) rows.push({ row: i + 1, cells });
  }
  return rows;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** First non-empty value among several header spellings. */
function pick(cells: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = cells[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return null;
}

function yes(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return ['y', 'yes', 'true', '1'].includes(s);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A date cell as YYYY-MM-DD, or null if it can't be read without guessing.
 *
 * Excel stores dates as serial numbers, which are unambiguous. Typed text is
 * accepted as 2026-10-12 or 12-Oct-2026 / 12 Oct 2026. 12/10/2026 is refused
 * on purpose: it is 12 October in Singapore and 10 December in the US, and a
 * schedule built on the wrong reading puts every session on the wrong day.
 */
export function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    if (!p || !validDate(p.y, p.m, p.d)) return null;
    return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    const [y, d] = [Number(m[3]), Number(m[1])];
    return mo > 0 && validDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  return null;
}

/**
 * A time cell as HH:MM (24-hour), or null.
 *
 * Excel stores times as a fraction of a day. Typed text is accepted as 09:30,
 * 9:30, 09:30:00, or with AM/PM.
 */
export function parseTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  }
  if (typeof v === 'number') {
    const frac = v - Math.floor(v);
    if (v >= 1 && frac === 0) return null; // a date with no time
    const minutes = Math.round(frac * 24 * 60);
    if (minutes >= 24 * 60) return null;
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  const m = String(v).trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
  }
  if (h > 23) return null;
  return `${pad(h)}:${pad(min)}`;
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function positiveNumber(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normaliseTier(v: unknown): Tier | null | 'invalid' {
  const s = text(v)?.toUpperCase();
  if (!s) return null;
  return (TIERS as readonly string[]).includes(s) ? (s as Tier) : 'invalid';
}

function normaliseMode(v: unknown): 'IN_PERSON' | 'VIRTUAL' | 'invalid' {
  const s = (text(v) ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (s === '' || s === 'inperson' || s === 'onsite' || s === 'physical') return 'IN_PERSON';
  if (s === 'video' || s === 'virtual' || s === 'online' || s === 'remote') return 'VIRTUAL';
  return 'invalid';
}

// ─── Reading and checking ──────────────────────────────────────────────────

/**
 * Parse and check a workbook buffer. Never throws for bad content: everything
 * wrong with the file comes back as an error in the result, so the person
 * uploading sees all of it at once rather than one problem per attempt.
 */
export function checkWorkbook(buffer: Buffer): CheckResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (sheet: string, row: number | null, message: string) => errors.push({ sheet, row, message });
  const warn = (sheet: string, row: number | null, message: string) => warnings.push({ sheet, row, message });

  const empty: ParsedWorkbook = { event: null, rooms: [], teams: [], judges: [], sessions: [], criteria: [] };

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch {
    err('File', null, 'This file could not be read as an Excel workbook. Save it as .xlsx and try again.');
    return finish(empty, errors, warnings);
  }

  const sheet = (name: string, required: boolean): RawRow[] => {
    const rows = readSheet(wb, name);
    if (rows === null) {
      if (required) err(name, null, `The "${name}" sheet is missing. Start from the template so every sheet is there.`);
      return [];
    }
    return rows;
  };

  // ── Event ──
  const eventRows = sheet('Event', true);
  let event: EventInfo | null = null;
  if (eventRows.length === 0 && wb.SheetNames.some((n) => n.trim().toLowerCase() === 'event')) {
    err('Event', 2, 'The Event sheet has no event details. Fill in row 2.');
  } else if (eventRows.length > 1) {
    err('Event', eventRows[1].row, 'The Event sheet should have one row. Delete the extra rows.');
  }
  if (eventRows.length >= 1) {
    const r = eventRows[0];
    const c = r.cells;
    const name = text(pick(c, 'event_name', 'name'));
    const tz = text(pick(c, 'timezone', 'time_zone')) ?? 'Asia/Singapore';
    const minutesRaw = pick(c, 'session_length', 'session_length_minutes', 'session_minutes');
    const minutes = positiveNumber(minutesRaw);
    const admins = (text(pick(c, 'admin_emails', 'admins', 'admin_email')) ?? '')
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (!name) err('Event', r.row, 'Event name is empty.');
    if (!validTimezone(tz)) err('Event', r.row, `"${tz}" is not a timezone this system recognises. Use a name like Asia/Singapore.`);
    if (minutesRaw === null) err('Event', r.row, 'Session length (minutes) is empty.');
    else if (minutes === null || !Number.isInteger(minutes) || minutes > 240) {
      err('Event', r.row, 'Session length must be a whole number of minutes, up to 240.');
    }
    for (const a of admins) {
      if (!EMAIL.test(a)) err('Event', r.row, `"${a}" in Admin emails is not an email address.`);
    }
    event = {
      name: name ?? '',
      location: text(pick(c, 'location', 'venue')),
      timezone: tz,
      sessionMinutes: minutes ?? 0,
      adminEmails: [...new Set(admins)],
    };
  }
  const timezone = event && validTimezone(event.timezone) ? event.timezone : null;

  // ── Rooms ──
  const rooms: RoomRow[] = [];
  const roomByName = new Map<string, RoomRow>();
  for (const r of sheet('Rooms', true)) {
    const name = text(pick(r.cells, 'room_name', 'room', 'name'));
    if (!name) {
      err('Rooms', r.row, 'Room name is empty.');
      continue;
    }
    const key = name.toLowerCase();
    if (roomByName.has(key)) {
      err('Rooms', r.row, `"${name}" is listed twice (also row ${roomByName.get(key)!.row}).`);
      continue;
    }
    const room = {
      row: r.row,
      name,
      location: text(pick(r.cells, 'location')),
      hasVideo: yes(pick(r.cells, 'video_conferencing', 'video', 'vc')),
    };
    rooms.push(room);
    roomByName.set(key, room);
  }

  // ── Teams ──
  const teams: TeamRow[] = [];
  const teamByName = new Map<string, TeamRow>();
  for (const r of sheet('Teams', true)) {
    const c = r.cells;
    const name = text(pick(c, 'team_name', 'team', 'name'));
    const projectName = text(pick(c, 'project_name', 'project'));
    const leadName = text(pick(c, 'team_lead_name', 'lead_name', 'team_lead'));
    const leadEmail = text(pick(c, 'team_lead_email', 'lead_email'))?.toLowerCase() ?? null;
    const mode = normaliseMode(pick(c, 'presentation_mode', 'mode'));
    const missing = [
      !name && 'Team name',
      !projectName && 'Project name',
      !leadName && 'Team lead name',
      !leadEmail && 'Team lead email',
    ].filter(Boolean);
    if (missing.length) err('Teams', r.row, `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} empty.`);
    if (leadEmail && !EMAIL.test(leadEmail)) err('Teams', r.row, `"${leadEmail}" is not an email address.`);
    if (mode === 'invalid') err('Teams', r.row, 'Presentation mode must be "In person" or "Video".');
    if (!name) continue;
    const key = name.toLowerCase();
    if (teamByName.has(key)) {
      err('Teams', r.row, `Team "${name}" is listed twice (also row ${teamByName.get(key)!.row}).`);
      continue;
    }
    const team: TeamRow = {
      row: r.row,
      name,
      projectName: projectName ?? '',
      track: text(pick(c, 'track')),
      country: text(pick(c, 'country'))?.toUpperCase() ?? null,
      organisation: text(pick(c, 'organisation', 'organization')),
      leadName: leadName ?? '',
      leadEmail: leadEmail ?? '',
      mode: mode === 'invalid' ? 'IN_PERSON' : mode,
      problemStatement: text(pick(c, 'problem_statement')),
      solutionSummary: text(pick(c, 'solution_summary')),
    };
    teams.push(team);
    teamByName.set(key, team);
  }

  // ── Judges ──
  const judges: JudgeRow[] = [];
  const judgeByEmail = new Map<string, JudgeRow>();
  for (const r of sheet('Judges', true)) {
    const c = r.cells;
    const name = text(pick(c, 'name', 'judge_name'));
    const email = text(pick(c, 'email', 'judge_email'))?.toLowerCase() ?? null;
    const tier = normaliseTier(pick(c, 'tier'));
    if (!name) err('Judges', r.row, 'Name is empty.');
    if (!email) {
      err('Judges', r.row, 'Email is empty. It is how the Schedule sheet refers to the judge.');
      continue;
    }
    if (!EMAIL.test(email)) {
      err('Judges', r.row, `"${email}" is not an email address.`);
      continue;
    }
    if (tier === 'invalid') err('Judges', r.row, `Tier must be one of ${TIERS.join(', ')}, or left blank.`);
    if (judgeByEmail.has(email)) {
      err('Judges', r.row, `${email} is listed twice (also row ${judgeByEmail.get(email)!.row}).`);
      continue;
    }
    const phone = pick(c, 'phone', 'mobile');
    const judge: JudgeRow = {
      row: r.row,
      name: name ?? email,
      email,
      phone: phone === null ? null : String(phone).trim(),
      organisation: text(pick(c, 'organisation', 'organization')),
      designation: text(pick(c, 'designation', 'title')),
      tier: tier === 'invalid' ? null : tier,
    };
    judges.push(judge);
    judgeByEmail.set(email, judge);
  }

  // ── Schedule ──
  const sessions: SessionRow[] = [];
  const scheduledTeams = new Map<string, number>();
  for (const r of sheet('Schedule', true)) {
    const c = r.cells;
    const rawDate = pick(c, 'date');
    const rawStart = pick(c, 'start_time', 'start');
    const rawEnd = pick(c, 'end_time', 'end');
    const date = parseDate(rawDate);
    const start = parseTime(rawStart);
    const end = parseTime(rawEnd);
    const roomName = text(pick(c, 'room'));
    const teamName = text(pick(c, 'team_name', 'team'));

    let bad = false;
    if (rawDate === null) { err('Schedule', r.row, 'Date is empty.'); bad = true; }
    else if (!date) { err('Schedule', r.row, `Date "${rawDate}" can't be read. Use YYYY-MM-DD, e.g. 2026-10-12.`); bad = true; }
    if (rawStart === null) { err('Schedule', r.row, 'Start time is empty.'); bad = true; }
    else if (!start) { err('Schedule', r.row, `Start time "${rawStart}" can't be read. Use 24-hour HH:MM, e.g. 09:30.`); bad = true; }
    if (rawEnd === null) { err('Schedule', r.row, 'End time is empty.'); bad = true; }
    else if (!end) { err('Schedule', r.row, `End time "${rawEnd}" can't be read. Use 24-hour HH:MM, e.g. 09:55.`); bad = true; }
    if (start && end && end <= start) { err('Schedule', r.row, `End time ${end} is not after start time ${start}.`); bad = true; }

    if (!roomName) { err('Schedule', r.row, 'Room is empty.'); bad = true; }
    else if (!roomByName.has(roomName.toLowerCase())) { err('Schedule', r.row, `Room "${roomName}" is not on the Rooms sheet.`); bad = true; }

    if (!teamName) { err('Schedule', r.row, 'Team name is empty.'); bad = true; }
    else if (!teamByName.has(teamName.toLowerCase())) { err('Schedule', r.row, `Team "${teamName}" is not on the Teams sheet.`); bad = true; }
    else {
      const key = teamName.toLowerCase();
      if (scheduledTeams.has(key)) {
        err('Schedule', r.row, `Team "${teamName}" is already scheduled on row ${scheduledTeams.get(key)}. Each team is judged once.`);
        bad = true;
      } else {
        scheduledTeams.set(key, r.row);
      }
    }

    const judgeEmails: string[] = [];
    for (let i = 1; i <= MAX_JUDGES_PER_SESSION; i++) {
      const raw = text(pick(c, `judge_${i}_email`, `judge_${i}`));
      if (!raw) continue;
      const email = raw.toLowerCase();
      if (!judgeByEmail.has(email)) {
        err('Schedule', r.row, `Judge ${i} (${email}) is not on the Judges sheet.`);
        bad = true;
      } else if (judgeEmails.includes(email)) {
        err('Schedule', r.row, `${email} is on this panel twice.`);
        bad = true;
      } else {
        judgeEmails.push(email);
      }
    }
    if (judgeEmails.length === 0 && !bad) {
      err('Schedule', r.row, 'No judges on this session. Judge 1 email is required.');
      bad = true;
    }

    if (bad || !date || !start || !end || !timezone) continue;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    sessions.push({
      row: r.row,
      date,
      start,
      end,
      startUtc: zonedTimeToUtc(date, sh, sm, timezone),
      endUtc: zonedTimeToUtc(date, eh, em, timezone),
      room: roomByName.get(roomName!.toLowerCase())!.name,
      team: teamByName.get(teamName!.toLowerCase())!.name,
      judgeEmails,
    });
  }

  // Overlaps: a room or a judge in two places at once.
  const overlaps = (key: (s: SessionRow) => string[], what: (k: string) => string) => {
    const byKey = new Map<string, SessionRow[]>();
    for (const s of sessions) for (const k of key(s)) byKey.set(k, [...(byKey.get(k) ?? []), s]);
    for (const [k, list] of byKey) {
      list.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        const cur = list[i];
        if (cur.startUtc < prev.endUtc) {
          err('Schedule', cur.row, `${what(k)} is booked at ${cur.date} ${cur.start}–${cur.end}, overlapping row ${prev.row} (${prev.start}–${prev.end}).`);
        }
      }
    }
  };
  overlaps((s) => [s.room.toLowerCase()], (k) => `Room "${roomByName.get(k)?.name ?? k}"`);
  overlaps((s) => s.judgeEmails, (k) => judgeByEmail.get(k)?.name ? `${judgeByEmail.get(k)!.name} (${k})` : k);

  // Warnings about the schedule as a whole.
  for (const s of sessions) {
    if (s.judgeEmails.length === 1) warn('Schedule', s.row, `${s.team} has only one judge.`);
    const team = teamByName.get(s.team.toLowerCase());
    const room = roomByName.get(s.room.toLowerCase());
    if (team?.mode === 'VIRTUAL' && room && !room.hasVideo) {
      warn('Schedule', s.row, `${s.team} presents by video, but ${room.name} has no video conferencing.`);
    }
  }
  const perJudgeDay = new Map<string, number>();
  for (const s of sessions) for (const e of s.judgeEmails) perJudgeDay.set(`${e}|${s.date}`, (perJudgeDay.get(`${e}|${s.date}`) ?? 0) + 1);
  for (const [k, n] of perJudgeDay) {
    if (n > HEAVY_DAY_SESSIONS) {
      const [email, date] = k.split('|');
      const j = judgeByEmail.get(email);
      warn('Schedule', null, `${j?.name ?? email} has ${n} sessions on ${date}.`);
    }
  }
  for (const t of teams) {
    if (!scheduledTeams.has(t.name.toLowerCase())) warn('Teams', t.row, `${t.name} is not on the Schedule, so it will not be judged.`);
  }
  const usedJudges = new Set(sessions.flatMap((s) => s.judgeEmails));
  for (const j of judges) {
    if (!usedJudges.has(j.email)) warn('Judges', j.row, `${j.name} is not on any session.`);
  }
  if (rooms.length > 0 && sessions.length > 0) {
    const usedRooms = new Set(sessions.map((s) => s.room.toLowerCase()));
    for (const r of rooms) if (!usedRooms.has(r.name.toLowerCase())) warn('Rooms', r.row, `${r.name} has no sessions.`);
  }
  if (sessions.length === 0 && !errors.some((e) => e.sheet === 'Schedule')) {
    err('Schedule', null, 'The Schedule sheet has no sessions.');
  }
  if (event && event.sessionMinutes > 0) {
    for (const s of sessions) {
      const mins = (s.endUtc.getTime() - s.startUtc.getTime()) / 60000;
      if (mins < event.sessionMinutes) {
        warn('Schedule', s.row, `${s.team}'s session is ${mins} minutes, shorter than the ${event.sessionMinutes}-minute session length.`);
      }
    }
  }

  // ── Criteria (optional) ──
  const criteria = checkCriteria(sheet('Criteria', false), err);

  return finish({ event, rooms, teams, judges, sessions, criteria }, errors, warnings);
}

/**
 * The rubric, if one is given. Same rules the scoring template enforces before
 * judges can score: two levels, categories add up to 100, and each category's
 * rows add up to that category's maximum.
 */
function checkCriteria(rows: RawRow[], err: (s: string, r: number | null, m: string) => void): CriterionRow[] {
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
      row: r.row,
      name,
      parent,
      maxScore: max,
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
    if (kids.length === 0) {
      err('Criteria', cat.row, `"${cat.name}" has no rows under it. Every category needs at least one row to score.`);
      continue;
    }
    const used = kids.reduce((s, k) => s + k.maxScore, 0);
    if (used !== cat.maxScore) err('Criteria', cat.row, `"${cat.name}" allows ${cat.maxScore} points but its rows add up to ${used}.`);
  }
  return out;
}

const SHEET_ORDER = ['File', 'Event', 'Rooms', 'Teams', 'Judges', 'Schedule', 'Criteria'];

/** Sheet by sheet in workbook order, then row by row, so the list reads like the file. */
function inFileOrder(issues: Issue[]): Issue[] {
  const rank = (s: string) => (SHEET_ORDER.indexOf(s) + 1) || SHEET_ORDER.length + 1;
  return [...issues].sort((a, b) => rank(a.sheet) - rank(b.sheet) || (a.row ?? 0) - (b.row ?? 0));
}

function finish(wb: ParsedWorkbook, errors: Issue[], warnings: Issue[]): CheckResult {
  errors = inFileOrder(errors);
  warnings = inFileOrder(warnings);
  const days = new Map<string, { sessions: number; judges: Set<string>; teams: Set<string> }>();
  for (const s of wb.sessions) {
    const d = days.get(s.date) ?? { sessions: 0, judges: new Set<string>(), teams: new Set<string>() };
    d.sessions++;
    s.judgeEmails.forEach((e) => d.judges.add(e));
    d.teams.add(s.team);
    days.set(s.date, d);
  }
  const categories = wb.criteria.filter((c) => !c.parent).length;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      eventName: wb.event?.name || null,
      timezone: wb.event?.timezone ?? null,
      rooms: wb.rooms.length,
      tracks: [...new Set(wb.teams.map((t) => t.track).filter((t): t is string => !!t))],
      teams: wb.teams.length,
      judges: wb.judges.length,
      sessions: wb.sessions.length,
      days: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({ date, sessions: d.sessions, judges: d.judges.size, teams: d.teams.size })),
      rubric: wb.criteria.length === 0 ? 'UOB rubric (Criteria sheet empty)' : `${categories} categories, ${wb.criteria.length - categories} rows`,
    },
    workbook: wb,
  };
}
