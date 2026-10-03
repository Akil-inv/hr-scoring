import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { BadRequestException } from '@nestjs/common';

/**
 * Read an uploaded spreadsheet, whichever format it arrives in.
 *
 * The imports took CSV only, and CSV loses data on the round trip. A solution
 * summary reading "faster onboarding, fewer errors, lower cost" is quoted
 * correctly when Excel first writes it — but the quoting is fragile. Edit the
 * file, re-save it somewhere less careful, and the row splits into three
 * columns. Nothing downstream can tell that happened, so the team's summary
 * silently becomes "faster onboarding" and two orphaned fields.
 *
 * Excel has no such problem: a cell holds its commas as data with nothing to
 * escape and nothing to interpret. So .xlsx is now the expected format and CSV
 * remains accepted, because people will still send it.
 *
 * Both paths produce the same thing — an array of objects keyed by header — so
 * every import service downstream is unchanged.
 */

/** Header text as written, and the key the importers expect. */
function normaliseHeader(header: string): string {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function parseSpreadsheet(file: Express.Multer.File): any[] {
  if (!file?.buffer?.length) {
    throw new BadRequestException('No file received, or the file is empty');
  }

  const name = (file.originalname || '').toLowerCase();
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls') ||
    file.mimetype?.includes('spreadsheet') ||
    file.mimetype?.includes('ms-excel');

  const rows = isExcel ? parseExcel(file) : parseCsv(file);

  if (rows.length === 0) {
    throw new BadRequestException(
      'No rows found. Check the first row holds the column names.',
    );
  }

  return rows;
}

function parseExcel(file: Express.Multer.File): any[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw new BadRequestException(
      'That file could not be read as a spreadsheet. If it was renamed to .xlsx, ' +
      'open it in Excel and use Save As instead.',
    );
  }

  // The first sheet, whatever it is called. A workbook with the data on sheet
  // two is a support conversation, not a silent empty import.
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new BadRequestException('The workbook has no sheets');

  const sheet = workbook.Sheets[sheetName];

  // `defval: ''` keeps empty cells as empty strings rather than dropping the
  // key, so a row missing its optional column still has the shape the
  // importers expect.
  const raw = XLSX.utils.sheet_to_json<any>(sheet, { defval: '', raw: false });

  return raw.map(row => {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      const k = normaliseHeader(key);
      if (!k) continue;
      // Dates come back as Date objects with cellDates; the importers parse
      // strings, so hand them the ISO date rather than a locale rendering.
      out[k] = value instanceof Date
        ? value.toISOString().split('T')[0]
        : String(value ?? '').trim();
    }
    return out;
  }).filter(row => Object.values(row).some(v => v !== ''));
}

function parseCsv(file: Express.Multer.File): any[] {
  const text = file.buffer.toString('utf-8').replace(/^\uFEFF/, '');

  const parsed = Papa.parse<any>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normaliseHeader,
  });

  // Papaparse reports malformed quoting rather than throwing. A field-count
  // mismatch is exactly the round-trip damage Excel upload exists to avoid, so
  // it is worth naming rather than importing a half-row.
  const badQuotes = (parsed.errors || []).filter(
    e => e.type === 'Quotes' || e.code === 'TooManyFields' || e.code === 'TooFewFields',
  );

  if (badQuotes.length > 0) {
    const first = badQuotes[0];
    throw new BadRequestException(
      `Row ${(first.row ?? 0) + 2} does not have the expected number of columns. ` +
      'This usually means a value contains a comma that is not quoted. ' +
      'Upload the file as .xlsx instead, where commas need no escaping.',
    );
  }

  return (parsed.data as any[]).filter(
    row => row && Object.values(row).some(v => String(v ?? '').trim() !== ''),
  );
}
