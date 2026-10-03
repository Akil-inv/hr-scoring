import * as XLSX from 'xlsx';
import { checkWorkbook, parseDate, parseTime, headerKey, HEAVY_DAY_SESSIONS } from './workbook';

type Sheets = Record<string, unknown[][]>;

const EVENT = [['Event name *', 'Location', 'Timezone', 'Session length (minutes) *', 'Admin emails'],
  ['Test Challenge', 'Level 12', 'Asia/Singapore', 25, 'admin@example.com']];
const ROOMS = [['Room name *', 'Location', 'Video conferencing'], ['Room A', 'L12', 'Y'], ['Room B', 'L12', 'N']];
const TEAMS = [
  ['Team name *', 'Project name *', 'Track', 'Country', 'Organisation', 'Team lead name *', 'Team lead email *', 'Presentation mode'],
  ['Alpha', 'Onboarding', 'CX', 'SG', 'UOB', 'Tan', 'tan@example.com', 'In person'],
  ['Beta', 'Fraud', 'Risk', 'MY', 'UOB', 'Faiz', 'faiz@example.com', 'Video'],
];
const JUDGES = [
  ['Name *', 'Email *', 'Phone', 'Organisation', 'Designation', 'Tier'],
  ['Lim', 'lim@example.com', '+6591234567', 'UOB', 'MD', 'L2'],
  ['Priya', 'priya@example.com', null, 'UOB', 'ED', 'L3'],
];
const SCHED_HEAD = ['Date *', 'Start time *', 'End time *', 'Room *', 'Team name *', 'Judge 1 email *', 'Judge 2 email', 'Judge 3 email'];
const SCHEDULE = [SCHED_HEAD,
  ['2026-10-12', '09:30', '09:55', 'Room A', 'Alpha', 'lim@example.com', 'priya@example.com'],
  ['2026-10-13', '10:00', '10:25', 'Room A', 'Beta', 'LIM@example.com', 'priya@example.com'],
];

function book(overrides: Partial<Sheets> = {}, omit: string[] = []): Buffer {
  const sheets: Sheets = { Event: EVENT, Rooms: ROOMS, Teams: TEAMS, Judges: JUDGES, Schedule: SCHEDULE, ...overrides };
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    if (omit.includes(name)) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows as any[][]), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const messages = (r: ReturnType<typeof checkWorkbook>, kind: 'errors' | 'warnings') =>
  r[kind].map((i) => `${i.sheet}${i.row ? `:${i.row}` : ''} ${i.message}`);

describe('checkWorkbook', () => {
  it('accepts a complete workbook and summarises it', () => {
    const r = checkWorkbook(book());
    expect(messages(r, 'errors')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({
      eventName: 'Test Challenge', timezone: 'Asia/Singapore', rooms: 2, teams: 2, judges: 2, sessions: 2,
      tracks: ['CX', 'Risk'], rubric: 'UOB rubric (Criteria sheet empty)',
    });
    expect(r.summary.days).toEqual([
      { date: '2026-10-12', sessions: 1, judges: 2, teams: 1 },
      { date: '2026-10-13', sessions: 1, judges: 2, teams: 1 },
    ]);
  });

  it('stores session times as UTC instants of the event-local wall clock', () => {
    const s = checkWorkbook(book()).workbook.sessions[0];
    // 09:30 in Singapore (UTC+8) is 01:30 UTC.
    expect(s.startUtc.toISOString()).toBe('2026-10-12T01:30:00.000Z');
    expect(s.endUtc.toISOString()).toBe('2026-10-12T01:55:00.000Z');
  });

  it('matches judge emails regardless of case', () => {
    const r = checkWorkbook(book());
    expect(r.workbook.sessions[1].judgeEmails).toEqual(['lim@example.com', 'priya@example.com']);
  });

  it('reads real Excel date and time cells', () => {
    const wb = XLSX.utils.book_new();
    const sheets: Sheets = { Event: EVENT, Rooms: ROOMS, Teams: TEAMS, Judges: JUDGES };
    for (const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows as any[][]), n);
    // 46307 = 2026-10-12; 0.395833 = 09:30; 0.413194 = 09:55
    const sched = XLSX.utils.aoa_to_sheet([SCHED_HEAD,
      [46307, 9.5 / 24, (9 + 55 / 60) / 24, 'Room A', 'Alpha', 'lim@example.com'],
      [46308, 10 / 24, (10 + 25 / 60) / 24, 'Room B', 'Beta', 'priya@example.com']]);
    XLSX.utils.book_append_sheet(wb, sched, 'Schedule');
    const r = checkWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    expect(messages(r, 'errors')).toEqual([]);
    expect(r.workbook.sessions.map((s) => [s.date, s.start, s.end])).toEqual([
      ['2026-10-12', '09:30', '09:55'],
      ['2026-10-13', '10:00', '10:25'],
    ]);
  });

  it('reports a missing sheet by name', () => {
    const r = checkWorkbook(book({}, ['Judges']));
    expect(r.ok).toBe(false);
    expect(messages(r, 'errors').join('\n')).toContain('The "Judges" sheet is missing');
  });

  it('rejects a file that is not a workbook', () => {
    const r = checkWorkbook(Buffer.from('not,a,workbook'));
    // SheetJS reads CSV text as a one-sheet book, so this surfaces as missing sheets.
    expect(r.ok).toBe(false);
  });

  it('flags unknown teams, judges and rooms on the schedule with their row', () => {
    const r = checkWorkbook(book({ Schedule: [SCHED_HEAD,
      ['2026-10-12', '09:30', '09:55', 'Room Z', 'Gamma', 'nobody@example.com']] }));
    const errs = messages(r, 'errors');
    expect(errs).toContain('Schedule:2 Room "Room Z" is not on the Rooms sheet.');
    expect(errs).toContain('Schedule:2 Team "Gamma" is not on the Teams sheet.');
    expect(errs).toContain('Schedule:2 Judge 1 (nobody@example.com) is not on the Judges sheet.');
  });

  it('refuses a team scheduled twice', () => {
    const r = checkWorkbook(book({ Schedule: [SCHED_HEAD,
      ['2026-10-12', '09:30', '09:55', 'Room A', 'Alpha', 'lim@example.com'],
      ['2026-10-13', '09:30', '09:55', 'Room A', 'Alpha', 'priya@example.com'],
      ['2026-10-13', '11:00', '11:25', 'Room A', 'Beta', 'priya@example.com']] }));
    expect(messages(r, 'errors')).toEqual([
      'Schedule:3 Team "Alpha" is already scheduled on row 2. Each team is judged once.',
    ]);
  });

  it('catches a judge booked in two rooms at once', () => {
    const r = checkWorkbook(book({ Schedule: [SCHED_HEAD,
      ['2026-10-12', '09:30', '09:55', 'Room A', 'Alpha', 'lim@example.com'],
      ['2026-10-12', '09:45', '10:10', 'Room B', 'Beta', 'lim@example.com']] }));
    expect(messages(r, 'errors')).toEqual([
      'Schedule:3 Lim (lim@example.com) is booked at 2026-10-12 09:45–10:10, overlapping row 2 (09:30–09:55).',
    ]);
  });

  it('catches a room double-booked, but allows back-to-back sessions', () => {
    const clash = checkWorkbook(book({ Schedule: [SCHED_HEAD,
      ['2026-10-12', '09:30', '09:55', 'Room A', 'Alpha', 'lim@example.com'],
      ['2026-10-12', '09:50', '10:15', 'Room A', 'Beta', 'priya@example.com']] }));
    expect(messages(clash, 'errors')[0]).toContain('Room "Room A" is booked at 2026-10-12 09:50–10:15');

    const backToBack = checkWorkbook(book({ Schedule: [SCHED_HEAD,
      ['2026-10-12', '09:30', '09:55', 'Room A', 'Alpha', 'lim@example.com'],
      ['2026-10-12', '09:55', '10:20', 'Room A', 'Beta', 'lim@example.com']] }));
    expect(messages(backToBack, 'errors')).toEqual([]);
  });

  it('refuses ambiguous dates and unreadable times', () => {
    const r = checkWorkbook(book({ Schedule: [SCHED_HEAD,
      ['12/10/2026', '9.30am', '25:00', 'Room A', 'Alpha', 'lim@example.com']] }));
    const errs = messages(r, 'errors');
    expect(errs).toContain('Schedule:2 Date "12/10/2026" can\'t be read. Use YYYY-MM-DD, e.g. 2026-10-12.');
    expect(errs).toContain('Schedule:2 End time "25:00" can\'t be read. Use 24-hour HH:MM, e.g. 09:55.');
  });

  it('refuses an end time that is not after the start', () => {
    const r = checkWorkbook(book({ Schedule: [SCHED_HEAD,
      ['2026-10-12', '10:00', '09:30', 'Room A', 'Alpha', 'lim@example.com']] }));
    expect(messages(r, 'errors')).toContain('Schedule:2 End time 09:30 is not after start time 10:00.');
  });

  it('refuses duplicate team names and judge emails', () => {
    const r = checkWorkbook(book({
      Teams: [...TEAMS, ['alpha', 'Other', 'CX', 'SG', 'UOB', 'X', 'x@example.com', '']],
      Judges: [...JUDGES, ['Lim Again', 'Lim@Example.com']],
    }));
    const errs = messages(r, 'errors');
    expect(errs).toContain('Teams:4 Team "alpha" is listed twice (also row 2).');
    expect(errs).toContain('Judges:4 lim@example.com is listed twice (also row 2).');
  });

  it('checks the Event sheet', () => {
    const r = checkWorkbook(book({ Event: [EVENT[0], ['', '', 'Mars/Olympus', 'twenty', 'not-an-email']] }));
    const errs = messages(r, 'errors');
    expect(errs).toContain('Event:2 Event name is empty.');
    expect(errs).toContain('Event:2 "Mars/Olympus" is not a timezone this system recognises. Use a name like Asia/Singapore.');
    expect(errs).toContain('Event:2 Session length must be a whole number of minutes, up to 240.');
    expect(errs).toContain('Event:2 "not-an-email" in Admin emails is not an email address.');
  });

  it('warns about thin panels, video rooms, and anything left unused', () => {
    const r = checkWorkbook(book({
      Teams: [...TEAMS, ['Gamma', 'Spare', 'CX', 'SG', 'UOB', 'G', 'g@example.com', '']],
      Judges: [...JUDGES, ['Idle', 'idle@example.com']],
      Schedule: [SCHED_HEAD,
        ['2026-10-12', '09:30', '09:55', 'Room A', 'Alpha', 'lim@example.com'],
        ['2026-10-12', '10:00', '10:25', 'Room B', 'Beta', 'priya@example.com', 'lim@example.com']],
    }));
    expect(messages(r, 'errors')).toEqual([]);
    expect(messages(r, 'warnings')).toEqual(expect.arrayContaining([
      'Schedule:2 Alpha has only one judge.',
      'Schedule:3 Beta presents by video, but Room B has no video conferencing.',
      'Teams:4 Gamma is not on the Schedule, so it will not be judged.',
      'Judges:4 Idle is not on any session.',
    ]));
  });

  it(`warns when a judge has more than ${HEAVY_DAY_SESSIONS} sessions in a day`, () => {
    const teams = [TEAMS[0]];
    const sched: unknown[][] = [SCHED_HEAD];
    for (let i = 0; i <= HEAVY_DAY_SESSIONS; i++) {
      teams.push([`T${i}`, 'P', 'CX', 'SG', 'UOB', 'L', `t${i}@example.com`, '']);
      const h = String(9 + i).padStart(2, '0');
      sched.push(['2026-10-12', `${h}:00`, `${h}:25`, 'Room A', `T${i}`, 'lim@example.com']);
    }
    const r = checkWorkbook(book({ Teams: teams, Schedule: sched }));
    expect(messages(r, 'errors')).toEqual([]);
    expect(messages(r, 'warnings')).toContain(`Schedule Lim has ${HEAVY_DAY_SESSIONS + 1} sessions on 2026-10-12.`);
  });

  describe('Criteria sheet', () => {
    const HEAD = ['Criterion *', 'Parent criterion', 'Max score *', 'Guidance', 'Comment required'];

    it('accepts a rubric whose categories total 100 and whose rows fill each category', () => {
      const r = checkWorkbook(book({ Criteria: [HEAD,
        ['Impact', null, 60], ['Value', 'Impact', 40], ['Reach', 'Impact', 20],
        ['Feasibility', null, 40], ['Build', 'Feasibility', 40, 'Can it ship?', 'Y']] }));
      expect(messages(r, 'errors')).toEqual([]);
      expect(r.summary.rubric).toBe('2 categories, 3 rows');
      expect(r.workbook.criteria.find((c) => c.name === 'Build')).toMatchObject({ requiresComment: true, guidance: 'Can it ship?' });
    });

    it('explains a rubric that does not add up', () => {
      const r = checkWorkbook(book({ Criteria: [HEAD,
        ['Impact', null, 50], ['Value', 'Impact', 30],
        ['Feasibility', null, 30],
        ['Deep', 'Value', 5]] }));
      const errs = messages(r, 'errors');
      expect(errs).toContain('Criteria Categories add up to 80. They must add up to 100.');
      expect(errs).toContain('Criteria:2 "Impact" allows 50 points but its rows add up to 30.');
      expect(errs).toContain('Criteria:4 "Feasibility" has no rows under it. Every category needs at least one row to score.');
      expect(errs).toContain('Criteria:5 "Value" is itself inside another category. Criteria go two levels deep at most.');
    });
  });
});

describe('cell parsing', () => {
  it('reads dates without guessing day/month order', () => {
    expect(parseDate('2026-10-12')).toBe('2026-10-12');
    expect(parseDate('2026-1-5')).toBe('2026-01-05');
    expect(parseDate('12-Oct-2026')).toBe('2026-10-12');
    expect(parseDate('12 October 2026')).toBe('2026-10-12');
    expect(parseDate(46307)).toBe('2026-10-12');
    expect(parseDate('12/10/2026')).toBeNull();
    expect(parseDate('2026-02-30')).toBeNull();
  });

  it('reads 24-hour, 12-hour and Excel fraction times', () => {
    expect(parseTime('09:30')).toBe('09:30');
    expect(parseTime('9:30')).toBe('09:30');
    expect(parseTime('09:30:00')).toBe('09:30');
    expect(parseTime('2:15 PM')).toBe('14:15');
    expect(parseTime('12:00 AM')).toBe('00:00');
    expect(parseTime(0.5)).toBe('12:00');
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('9am')).toBeNull();
  });

  it('normalises headers', () => {
    expect(headerKey('Session length (minutes) *')).toBe('session_length');
    expect(headerKey('Judge 1 email *')).toBe('judge_1_email');
    expect(headerKey('  Team Lead Email ')).toBe('team_lead_email');
  });
});
