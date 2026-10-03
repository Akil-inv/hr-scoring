import { Issue, inFileOrder, isBlank, parseDate, parseTime, readSheet, readWorkbook, text } from '../setup-upload/cells';

/**
 * Reads a candidates file: one sheet, "Candidates", with Name, Date and Time.
 * Time is the start of an interview slot. Only the shape of each row is
 * checked here; whether the slot exists and is free needs the schedule, which
 * the service checks.
 */

export type CandidateRow = { row: number; name: string; date: string; time: string };

export function readCandidatesWorkbook(buffer: Buffer): { rows: CandidateRow[]; errors: Issue[] } {
  const errors: Issue[] = [];
  const err = (row: number | null, message: string) => errors.push({ sheet: 'Candidates', row, message });
  const wb = readWorkbook(buffer);
  if (!wb) {
    return { rows: [], errors: [{ sheet: 'File', row: null, message: 'This file could not be read as an Excel workbook. Save it as .xlsx and try again.' }] };
  }
  const raw = readSheet(wb, 'Candidates');
  if (raw === null) {
    return { rows: [], errors: [{ sheet: 'Candidates', row: null, message: 'The "Candidates" sheet is missing. Start from the candidates template.' }] };
  }

  const rows: CandidateRow[] = [];
  const seen = new Map<string, number>();
  for (const r of raw) {
    const c = r.cells;
    const name = text(c.name ?? c.candidate_name ?? c.candidate);
    const rawDate = c.date;
    const rawTime = c.time ?? c.start_time ?? c.slot;
    const date = parseDate(rawDate);
    const time = parseTime(rawTime);
    let bad = false;
    if (!name) { err(r.row, 'Name is empty.'); bad = true; }
    if (isBlank(rawDate)) { err(r.row, 'Date is empty.'); bad = true; }
    else if (!date) { err(r.row, `Date "${rawDate}" can't be read. Use YYYY-MM-DD, e.g. 2026-10-19.`); bad = true; }
    if (isBlank(rawTime)) { err(r.row, 'Time is empty.'); bad = true; }
    else if (!time) { err(r.row, `Time "${rawTime}" can't be read. Use 24-hour HH:MM, e.g. 09:20.`); bad = true; }
    if (name) {
      const key = name.toLowerCase();
      if (seen.has(key)) { err(r.row, `${name} is listed twice in this file (also row ${seen.get(key)}).`); bad = true; }
      else seen.set(key, r.row);
    }
    if (!bad) rows.push({ row: r.row, name: name!, date: date!, time: time! });
  }
  if (raw.length === 0) err(null, 'The Candidates sheet has no rows.');
  return { rows, errors: inFileOrder(errors, ['File', 'Candidates']) };
}
