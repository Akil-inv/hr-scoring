import * as XLSX from 'xlsx';

/**
 * Reading cells from uploaded workbooks. Shared by the setup upload and the
 * candidate upload so both read dates, times and headers the same way.
 */

export type Issue = { sheet: string; row: number | null; message: string };

export type RawRow = { row: number; cells: Record<string, unknown> };

/**
 * Header text to a stable key: lowercase, no asterisks, bracketed notes,
 * punctuation or extra spaces. "Duration (minutes) *" becomes "duration".
 */
export function headerKey(header: unknown): string {
  return String(header ?? '')
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function findSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet | null {
  const actual = wb.SheetNames.find((n) => n.trim().toLowerCase() === name.toLowerCase());
  return actual ? wb.Sheets[actual] : null;
}

/** A sheet as a grid of raw values, row 0 being the header row. */
export function readGrid(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true });
}

/**
 * A sheet as rows of {header key → raw cell value}, keeping the spreadsheet
 * row number so every message can point at the exact line. Empty rows are
 * skipped. Null when the sheet is missing.
 */
export function readSheet(wb: XLSX.WorkBook, name: string): RawRow[] | null {
  const sheet = findSheet(wb, name);
  if (!sheet) return null;
  const grid = readGrid(sheet);
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
      if (!isBlank(v)) any = true;
      cells[h] = v;
    });
    if (any) rows.push({ row: i + 1, cells });
  }
  return rows;
}

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === '';
}

export function text(v: unknown): string | null {
  if (isBlank(v)) return null;
  return String(v).trim();
}

/** First non-empty value among several header spellings. */
export function pick(cells: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (!isBlank(cells[k])) return cells[k];
  }
  return null;
}

export function yes(v: unknown): boolean {
  return ['y', 'yes', 'true', '1'].includes(String(v ?? '').trim().toLowerCase());
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function pad(n: number): string {
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
 * schedule built on the wrong reading puts every interview on the wrong day.
 */
export function parseDate(v: unknown): string | null {
  if (isBlank(v)) return null;
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
  if (isBlank(v)) return null;
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

/** "09:30" → 570 minutes after midnight. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 570 → "09:30". */
export function hhmmOf(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function positiveNumber(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Sheet by sheet in workbook order, then row by row, so a list reads like the file. */
export function inFileOrder(issues: Issue[], sheetOrder: string[]): Issue[] {
  const rank = (s: string) => (sheetOrder.indexOf(s) + 1) || sheetOrder.length + 1;
  return [...issues].sort((a, b) => rank(a.sheet) - rank(b.sheet) || (a.row ?? 0) - (b.row ?? 0));
}

export function readWorkbook(buffer: Buffer): XLSX.WorkBook | null {
  try {
    return XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch {
    return null;
  }
}
