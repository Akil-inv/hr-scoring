import * as XLSX from 'xlsx';
import { CandidateRecord, DECISION_LABEL, Decision, ReviewData } from './review.service';

/**
 * The results workbooks.
 *
 * Day workbook (one date):        Summary · Judge scores · Judge comments (points)
 *                                  or Judge summary (rating rubrics)
 * Consolidated (all dates so far): All days · one summary sheet per day ·
 *                                  Judge scores · Judge comments
 *
 * Summary is one row per candidate: the consolidated score (average across
 * the judges who submitted, with category averages), the HR admin's decision
 * and feedback. Judge scores is the raw data, one row per judge per
 * criterion. Judge comments is one row per judge per candidate.
 */

const GROUP_ORDER: (Decision | 'NONE')[] = ['SELECTED', 'WAITLIST', 'NOT_SELECTED', 'DID_NOT_ATTEND', 'NONE'];

const STATE_LABEL: Record<CandidateRecord['state'], string> = {
  AWAITING: 'Awaiting scores',
  READY: 'Ready for decision',
  DECIDED: 'Decided',
};

const SCORECARD_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  REOPENED: 'Reopened',
  RESUBMITTED: 'Resubmitted',
  LOCKED: 'Locked',
};

function decisionOf(r: CandidateRecord): Decision | 'NONE' {
  return r.decision?.status === 'SUBMITTED' && r.decision.decision ? r.decision.decision : 'NONE';
}

/** Selected first, then Waitlist, Not selected, undecided; best average first within each. */
export function resultsOrder(records: CandidateRecord[]): CandidateRecord[] {
  return [...records].sort((a, b) =>
    GROUP_ORDER.indexOf(decisionOf(a)) - GROUP_ORDER.indexOf(decisionOf(b))
    || (b.average ?? -1) - (a.average ?? -1)
    || a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

function when(d: Date | null, tz: string): string {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d).replace(',', '');
}

function sheet(rows: (string | number | null)[][], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  if (rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
  return ws;
}

function summarySheet(data: ReviewData, records: CandidateRecord[], withDate: boolean): XLSX.WorkSheet {
  const cats = records[0]?.categoryAverages ?? data.criteria.filter((c) => !c.parentId).map((c) => ({ name: c.name, maxScore: c.maxScore }));
  const rating = data.scale === 'RATING';
  const sq = data.supportQuestion;
  const head = [
    'Decision', 'Candidate', ...(withDate ? ['Date'] : []), 'Time', 'Panel', 'Judges scored',
    rating ? `Average rating (out of ${data.scoreMax})` : `Average score (out of ${data.maxTotal})`,
    ...(sq ? [`${sq} (Yes)`] : []),
    ...cats.map((c) => `${c.name} (out of ${c.maxScore})`),
    'HR comments', 'Record status', 'Decided by', 'Decided at',
  ];
  const rows: (string | number | null)[][] = [head];
  for (const r of resultsOrder(records)) {
    const d = decisionOf(r);
    rows.push([
      d === 'NONE' ? '' : DECISION_LABEL[d],
      r.name,
      ...(withDate ? [r.date] : []),
      `${r.start}–${r.end}`,
      r.judges.filter((j) => !j.excused).map((j) => j.name).join(', '),
      `${r.submitted} of ${r.expected}`,
      r.average,
      ...(sq ? [`${r.support.yes} of ${r.judges.filter((j) => j.submitted).length}`] : []),
      ...r.categoryAverages.map((c) => c.average),
      r.decision?.feedback ?? '',
      r.decision?.status === 'DRAFT' && r.state !== 'DECIDED' ? `${STATE_LABEL[r.state]} (draft decision)` : STATE_LABEL[r.state],
      r.decision?.status === 'SUBMITTED' ? r.decision.decidedBy ?? '' : '',
      r.decision?.status === 'SUBMITTED' ? when(r.decision.decidedAt, data.event.timezone) : '',
    ]);
  }
  return sheet(rows, [14, 26, ...(withDate ? [12] : []), 13, 34, 13, 16, ...(sq ? [14] : []), ...cats.map(() => 18), 60, 22, 20, 17]);
}

function judgeScoresSheet(data: ReviewData, records: CandidateRecord[]): XLSX.WorkSheet {
  const parents = new Set(data.criteria.map((c) => c.parentId).filter(Boolean));
  const leaves = data.criteria.filter((c) => !parents.has(c.id)).sort((a, b) => a.order - b.order);
  const nameOf = new Map(data.criteria.map((c) => [c.id, c.name]));
  if (data.scale === 'RATING') {
    const rows: (string | number | null)[][] = [[
      'Date', 'Time', 'Candidate', 'Judge', 'Dimension', 'Rating', 'Out of', 'Comment', 'Scorecard status',
    ]];
    for (const r of records) {
      for (const j of r.judges) {
        for (const l of leaves) {
          const s = j.scores[l.id];
          rows.push([r.date, r.start, r.name, j.name, l.name, s?.score ?? null, l.maxScore, s?.comment ?? '', SCORECARD_LABEL[j.status] ?? j.status]);
        }
      }
    }
    return sheet(rows, [12, 8, 26, 20, 32, 8, 8, 80, 16]);
  }
  const rows: (string | number | null)[][] = [[
    'Date', 'Time', 'Candidate', 'Judge', 'Category', 'Criterion', 'Score', 'Out of', 'Criterion comment', 'Scorecard status',
  ]];
  for (const r of records) {
    for (const j of r.judges) {
      for (const l of leaves) {
        const s = j.scores[l.id];
        rows.push([
          r.date, r.start, r.name, j.name, l.parentId ? nameOf.get(l.parentId) ?? '' : '', l.name,
          s?.score ?? null, l.maxScore, s?.comment ?? '', SCORECARD_LABEL[j.status] ?? j.status,
        ]);
      }
    }
  }
  return sheet(rows, [12, 8, 26, 20, 30, 60, 8, 8, 50, 16]);
}

function judgeCommentsSheet(data: ReviewData, records: CandidateRecord[]): XLSX.WorkSheet {
  if (data.scale === 'RATING') {
    // Comments are per dimension (on Judge scores); this is each judge's
    // overall line for the candidate.
    const parents = new Set(data.criteria.map((c) => c.parentId).filter(Boolean));
    const leaves = data.criteria.filter((c) => !parents.has(c.id));
    const sq = data.supportQuestion;
    const rows: (string | number | null)[][] = [[
      'Date', 'Time', 'Candidate', 'Judge', `Average rating (out of ${data.scoreMax})`, ...(sq ? [sq] : []),
      ...leaves.map((l) => l.name), 'Scorecard status', 'Submitted at',
    ]];
    for (const r of records) {
      for (const j of r.judges) {
        const vals = leaves.map((l) => j.scores[l.id]?.score ?? null);
        const got = vals.filter((v): v is number => v !== null);
        rows.push([
          r.date, r.start, r.name, j.name + (j.excused ? ' (stepped out)' : ''),
          j.submitted && got.length ? Math.round((got.reduce((a, b) => a + b, 0) / got.length) * 10) / 10 : null,
          ...(sq ? [j.support === true ? 'Yes' : j.support === false ? 'No' : ''] : []),
          ...vals, SCORECARD_LABEL[j.status] ?? j.status, when(j.submittedAt, data.event.timezone),
        ]);
      }
    }
    return sheet(rows, [12, 8, 26, 22, 14, ...(sq ? [14] : []), ...leaves.map(() => 16), 16, 17]);
  }
  const rows: (string | number | null)[][] = [[
    'Date', 'Time', 'Candidate', 'Judge', `Total (out of ${data.maxTotal})`, 'Strengths', 'Areas for improvement',
    'Recommendation', 'Scorecard status', 'Submitted at',
  ]];
  for (const r of records) {
    for (const j of r.judges) {
      rows.push([
        r.date, r.start, r.name, j.name + (j.excused ? ' (stepped out)' : ''), j.submitted ? j.total : null,
        j.strengths ?? '', j.areasForImprovement ?? '', j.recommendation ?? '',
        SCORECARD_LABEL[j.status] ?? j.status, when(j.submittedAt, data.event.timezone),
      ]);
    }
  }
  return sheet(rows, [12, 8, 26, 22, 14, 50, 50, 40, 16, 17]);
}

/** Build the workbook for one date, or for every date when none is given. */
export function buildResultsWorkbook(data: ReviewData, date?: string): Buffer {
  const wb = XLSX.utils.book_new();
  const records = [...data.records].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  if (date) {
    const day = records.filter((r) => r.date === date);
    XLSX.utils.book_append_sheet(wb, summarySheet(data, day, false), 'Summary');
    XLSX.utils.book_append_sheet(wb, judgeScoresSheet(data, day), 'Judge scores');
    XLSX.utils.book_append_sheet(wb, judgeCommentsSheet(data, day), data.scale === 'RATING' ? 'Judge summary' : 'Judge comments');
  } else {
    XLSX.utils.book_append_sheet(wb, summarySheet(data, records, true), 'All days');
    for (const d of data.days) {
      XLSX.utils.book_append_sheet(wb, summarySheet(data, records.filter((r) => r.date === d.date), false), dayLabel(d.date).replace(/,/g, ''));
    }
    XLSX.utils.book_append_sheet(wb, judgeScoresSheet(data, records), 'Judge scores');
    XLSX.utils.book_append_sheet(wb, judgeCommentsSheet(data, records), data.scale === 'RATING' ? 'Judge summary' : 'Judge comments');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function resultsFileName(eventName: string, date?: string): string {
  const base = eventName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'results';
  return `${base}-${date ?? 'all-days'}-results.xlsx`;
}
