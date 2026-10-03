import * as XLSX from 'xlsx';
import { checkWorkbook, parseAvailability } from './workbook';
import { headerKey, parseDate, parseTime } from './cells';

type Sheets = Record<string, unknown[][]>;

const EVENT = [['Event name *', 'Location', 'Timezone', 'Minimum panel size', 'Admin emails'],
  ['Interviews', 'L12', 'Asia/Singapore', 2, 'admin@example.com']];
const TEMPLATE = [['Block *', 'Start time *', 'Item *', 'Duration (minutes) *'],
  ['AM', '09:00', 'Interview', 20],
  ['AM', null, 'Interview', 20],
  ['AM', null, 'Break', 10],
  ['AM', null, 'Interview', 20],
  ['AM', null, 'Calibration', 10],
  ['PM', '14:00', 'Interview', 20],
  ['PM', null, 'Interview', 20],
  ['PM', null, 'Calibration', 10]];
const JUDGES = [['Name *', 'Email *', 'Phone', 'Organisation', 'Designation', 'Tier'],
  ['Dean', 'dean@example.com'], ['Lawrance', 'lawrance@example.com'], ['Choon Hin', 'choonhin@example.com']];
const AVAIL = [['Judge email *', '2026-10-19 AM', '2026-10-19 PM', '2026-10-20 AM', '2026-10-20 PM'],
  ['dean@example.com', 'Yes', 'Yes', 'No', null],
  ['Lawrance@Example.com', 'yes', '14:00-14:20', 'No', null],
  ['choonhin@example.com', 'Yes', 'No', 'No', null]];

function book(overrides: Partial<Sheets> = {}, omit: string[] = []): Buffer {
  const sheets: Sheets = { Event: EVENT, 'Day template': TEMPLATE, Judges: JUDGES, Availability: AVAIL, ...overrides };
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    if (omit.includes(name)) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows as any[][]), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const msgs = (r: ReturnType<typeof checkWorkbook>, kind: 'errors' | 'warnings') =>
  r[kind].map((i) => `${i.sheet}${i.row ? `:${i.row}` : ''} ${i.message}`);

describe('checkWorkbook (interview setup)', () => {
  it('builds slots from the template, one block per available date', () => {
    const r = checkWorkbook(book());
    expect(msgs(r, 'errors')).toEqual([]);
    // 20 Oct has nobody, so only 19 Oct AM and PM are scheduled.
    expect(r.workbook.schedule.map((b) => `${b.date} ${b.block}`)).toEqual(['2026-10-19 AM', '2026-10-19 PM']);
    const am = r.workbook.schedule[0].slots;
    expect(am.map((s) => `${s.kind} ${s.start}-${s.end}`)).toEqual([
      'INTERVIEW 09:00-09:20', 'INTERVIEW 09:20-09:40', 'BREAK 09:40-09:50', 'INTERVIEW 09:50-10:10', 'CALIBRATION 10:10-10:20',
    ]);
    expect(am[0].startUtc.toISOString()).toBe('2026-10-19T01:00:00.000Z');
    expect(am[0].panel).toEqual(['dean@example.com', 'lawrance@example.com', 'choonhin@example.com']);
    expect(am[2].panel).toEqual([]);
  });

  it('seats a judge only in interviews that fit inside their window', () => {
    const pm = checkWorkbook(book()).workbook.schedule[1].slots;
    // Lawrance 14:00-14:20 covers the first interview only. With Dean that's 2 = the minimum.
    expect(pm[0].panel).toEqual(['dean@example.com', 'lawrance@example.com']);
    // The second interview has Dean alone: below the minimum of 2, so no panel.
    expect(pm[1].available).toEqual(['dean@example.com']);
    expect(pm[1].panel).toEqual([]);
  });

  it('warns about interviews left without a panel and summarises the schedule', () => {
    const r = checkWorkbook(book());
    expect(msgs(r, 'warnings')).toContain('Availability 2026-10-19 PM: 1 of 2 interviews have fewer than 2 judges available, so they have no panel.');
    expect(r.summary).toMatchObject({ judges: 3, days: 1, interviews: 5, interviewsWithPanel: 4, minPanel: 2 });
    expect(r.summary.blocks).toEqual([
      { block: 'AM', start: '09:00', end: '10:20', interviews: 3 },
      { block: 'PM', start: '14:00', end: '14:50', interviews: 2 },
    ]);
    expect(r.summary.schedule[0].blocks[1]).toEqual({ block: 'PM', interviews: 2, withPanel: 1, judges: ['Dean', 'Lawrance'] });
  });

  it('honours a minimum panel size of 1', () => {
    const r = checkWorkbook(book({ Event: [EVENT[0], ['Interviews', null, null, 1, null]] }));
    expect(r.workbook.schedule[1].slots[1].panel).toEqual(['dean@example.com']);
  });

  it('refuses anything in the grid that is not Yes, No or a window, naming judge and column', () => {
    const r = checkWorkbook(book({ Availability: [AVAIL[0], ['dean@example.com', 'No. 1.3 PM ok', '1-4pm', 'Yes', 'maybe']] }));
    expect(msgs(r, 'errors')).toEqual([
      'Availability:2 Dean, 2026-10-19 AM: "No. 1.3 PM ok" isn\'t Yes, No or a time window like 13:00-16:00.',
      'Availability:2 Dean, 2026-10-19 PM: "1-4pm" isn\'t Yes, No or a time window like 13:00-16:00.',
      'Availability:2 Dean, 2026-10-20 PM: "maybe" isn\'t Yes, No or a time window like 13:00-16:00.',
    ]);
  });

  it('checks the grid headers and judges', () => {
    const r = checkWorkbook(book({ Availability: [
      ['Judge email *', '19/10/2026 AM', '2026-10-19 Evening', '2026-10-19 AM', '2026-10-19 am'],
      ['nobody@example.com', 'Yes'],
      ['dean@example.com', 'Yes', 'Yes', 'Yes'],
      ['dean@example.com', 'Yes'],
    ] }));
    expect(msgs(r, 'errors')).toEqual([
      'Availability:1 Column header "19/10/2026 AM" should be a date and block, e.g. 2026-10-19 AM.',
      'Availability:1 Column "2026-10-19 Evening": block "Evening" is not on the Day template sheet.',
      'Availability:1 Column "2026-10-19 am" repeats "2026-10-19 AM".',
      'Availability:2 nobody@example.com is not on the Judges sheet.',
      'Availability:4 dean@example.com has two rows (also row 3).',
    ]);
    expect(msgs(r, 'warnings')).toContain('Judges:3 Lawrance has no row on the Availability sheet, so won\'t sit any interviews.');
  });

  it('warns when a window covers no whole interview', () => {
    const r = checkWorkbook(book({ Availability: [AVAIL[0], ...AVAIL.slice(1, 3), ['choonhin@example.com', 'Yes', '14:05-14:30']] }));
    expect(msgs(r, 'warnings')).toContain(
      'Availability:4 Choon Hin\'s window 14:05-14:30 on 2026-10-19 PM doesn\'t cover a whole interview, so they won\'t sit any.');
  });

  it('checks the day template', () => {
    const r = checkWorkbook(book({ 'Day template': [TEMPLATE[0],
      ['AM', null, 'Interview', 20],
      ['AM', '09:00', 'Interview', 20],
      ['AM', '09:10', 'Interview', 20],
      ['AM', null, 'Lunch hour', 20],
      ['PM', '10:00', 'Break', 10],
      ['AM', null, 'Interview', 'twenty']] }));
    expect(msgs(r, 'errors')).toEqual(expect.arrayContaining([
      'Day template:2 The first row of block AM needs a start time.',
      'Day template:4 Start time 09:10 overlaps the previous item in AM, which ends at 09:20.',
      'Day template:5 Item must be Interview, Break or Calibration.',
      'Day template:6 Block PM has no interviews.',
      'Day template:7 Duration must be a whole number of minutes, up to 240.',
    ]));
  });

  it('refuses blocks that overlap, since one panel cannot be in both', () => {
    const r = checkWorkbook(book({ 'Day template': [TEMPLATE[0], ['AM', '09:00', 'Interview', 60], ['PM', '09:30', 'Interview', 20]] }));
    expect(msgs(r, 'errors')).toContain('Day template:3 Block PM starts at 09:30, before block AM ends at 10:00. One panel can\'t be in both.');
  });

  it('allows a gap by giving a later row its own start time', () => {
    const r = checkWorkbook(book({
      'Day template': [TEMPLATE[0], ['AM', '09:00', 'Interview', 20], ['AM', '10:00', 'Interview', 20]],
      Availability: [['Judge email *', '2026-10-19 AM'], ['dean@example.com', 'Yes'], ['lawrance@example.com', 'Yes'], ['choonhin@example.com', 'Yes']],
    }));
    expect(msgs(r, 'errors')).toEqual([]);
    expect(r.workbook.schedule[0].slots.map((s) => s.start)).toEqual(['09:00', '10:00']);
  });

  it('reports missing sheets and an unreadable file', () => {
    expect(msgs(checkWorkbook(book({}, ['Availability'])), 'errors')).toContain(
      'Availability The "Availability" sheet is missing. Start from the template so every sheet is there.');
    expect(checkWorkbook(Buffer.from('nope')).ok).toBe(false);
  });

  it('refuses a schedule nobody can sit', () => {
    const r = checkWorkbook(book({ Availability: [AVAIL[0], ['dean@example.com', 'No', 'No', 'No', 'No']] }));
    expect(msgs(r, 'errors')).toContain('Availability No judge is available for any block, so there is nothing to schedule.');
  });

  describe('Criteria sheet', () => {
    const HEAD = ['Criterion *', 'Parent criterion', 'Max score *', 'Guidance', 'Comment required'];
    it('accepts a rubric that adds up', () => {
      const r = checkWorkbook(book({ Criteria: [HEAD, ['Impact', null, 60], ['Value', 'Impact', 60], ['Fit', null, 40], ['Team', 'Fit', 40, 'Works well', 'Y']] }));
      expect(msgs(r, 'errors')).toEqual([]);
      expect(r.summary.rubric).toBe('2 categories, 2 rows');
    });
    it('explains a rubric that does not', () => {
      const r = checkWorkbook(book({ Criteria: [HEAD, ['Impact', null, 50], ['Value', 'Impact', 30]] }));
      expect(msgs(r, 'errors')).toEqual([
        'Criteria Categories add up to 50. They must add up to 100.',
        'Criteria:2 "Impact" allows 50 points but its rows add up to 30.',
      ]);
    });
  });
});

describe('Rubric sheet (1-5 ratings)', () => {
  const HEAD = ['Dimension *', 'Descriptor', 'Score: 1 (Low) *', 'Score: 3 (Moderate) *', 'Score: 5 (High) *'];
  const dim = (n: string) => [n, `About ${n}`, `${n} low`, `${n} moderate`, `${n} high`];

  it('uses the LAP rubric and its question when no rubric is given', () => {
    const r = checkWorkbook(book());
    expect(r.summary.rubric).toBe('LAP rubric, 5 dimensions rated 1-5 (Rubric sheet empty)');
    expect(r.summary.supportQuestion).toBe('Support for LAP');
  });

  it('reads dimensions and the support question', () => {
    const ev = [[...EVENT[0], 'Support question'], [...EVENT[1], 'Recommend for programme']];
    const r = checkWorkbook(book({ Event: ev, Rubric: [HEAD, dim('Drive'), dim('Agility'), dim('Mobility')] }));
    expect(msgs(r, 'errors')).toEqual([]);
    expect(r.summary.rubric).toBe('3 dimensions rated 1-5');
    expect(r.summary.supportQuestion).toBe('Recommend for programme');
    expect(r.workbook.rating[1]).toEqual({ row: 3, name: 'Agility', descriptor: 'About Agility', low: 'Agility low', moderate: 'Agility moderate', high: 'Agility high' });
  });

  it('needs every description, and at least three dimensions', () => {
    const r = checkWorkbook(book({ Rubric: [HEAD, dim('Drive'), ['Agility', null, 'low', null, 'high']] }));
    expect(msgs(r, 'errors')).toEqual([
      'Rubric The rubric has 1 dimension. It needs at least 3.',
      'Rubric:3 "Agility" needs a description for Score 3. Judges see these while scoring.',
    ]);
  });

  it('refuses both rubric sheets at once', () => {
    const r = checkWorkbook(book({
      Rubric: [HEAD, dim('A'), dim('B'), dim('C')],
      Criteria: [['Criterion *', 'Parent criterion', 'Max score *'], ['Impact', null, 100], ['Value', 'Impact', 100]],
    }));
    expect(msgs(r, 'errors')).toEqual(['Rubric Both the Rubric and the Criteria sheets are filled in. Use one: Rubric for 1-5 ratings, Criteria for points.']);
  });
});

describe('cell parsing', () => {
  it('reads availability cells strictly', () => {
    expect(parseAvailability('Yes')).toEqual({ kind: 'ALL' });
    expect(parseAvailability('ok')).toEqual({ kind: 'ALL' });
    expect(parseAvailability('No')).toBeNull();
    expect(parseAvailability(null)).toBeNull();
    expect(parseAvailability('13:00-16:00')).toEqual({ kind: 'WINDOW', from: 780, to: 960 });
    expect(parseAvailability('9:00 – 10:30')).toEqual({ kind: 'WINDOW', from: 540, to: 630 });
    expect(parseAvailability('16:00-13:00')).toBe('invalid');
    expect(parseAvailability('1-3 PM')).toBe('invalid');
    expect(parseAvailability('No. 1.3 PM ok')).toBe('invalid');
  });

  it('reads dates without guessing day/month order', () => {
    expect(parseDate('2026-10-19')).toBe('2026-10-19');
    expect(parseDate('19-Oct-2026')).toBe('2026-10-19');
    expect(parseDate(46314)).toBe('2026-10-19');
    expect(parseDate('19/10/2026')).toBeNull();
  });

  it('reads times', () => {
    expect(parseTime('09:00')).toBe('09:00');
    expect(parseTime('2:15 PM')).toBe('14:15');
    expect(parseTime(14 / 24)).toBe('14:00');
    expect(parseTime('25:00')).toBeNull();
  });

  it('normalises headers', () => {
    expect(headerKey('Duration (minutes) *')).toBe('duration');
    expect(headerKey('Minimum panel size')).toBe('minimum_panel_size');
  });
});

describe('a candidates file on the setup page', () => {
  it('says what it is instead of listing missing sheets', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name *', 'Date *', 'Time *'], ['A', '2026-10-19', '09:00']]), 'Candidates');
    const r = checkWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    expect(r.errors.map((e) => e.message)).toEqual([
      'This is a candidates file. Upload it on the Schedule page (Upload candidates), after the setup workbook has created the schedule.',
    ]);
  });
});
