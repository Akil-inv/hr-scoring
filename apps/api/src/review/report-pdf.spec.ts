import { buildReportPdf, reportFileName, reportRef, scoreTone } from './report-pdf';
import { LAP_RUBRIC, ratingAnchors } from '../scoring-templates/lap-rubric';
import { CandidateRecord, ReviewData } from './review.service';

const criteria = LAP_RUBRIC.dimensions.map((d, i) => ({
  id: `c${i}`, name: d.name, parentId: null, minScore: 1, maxScore: 5, order: i, description: d.descriptor, anchors: ratingAnchors(d),
}));

function record(scores: number[][], support: boolean[]): CandidateRecord {
  const judges = ['Hendra', 'Jack', 'Wei Wei'].map((name, k) => ({
    judgeId: `j${k}`, name, excused: false, status: 'SUBMITTED', submitted: true,
    total: scores.reduce((a, row) => a + row[k], 0), submittedAt: new Date('2026-10-19T02:00:00Z'),
    strengths: null, areasForImprovement: null, recommendation: null, support: support[k],
    scores: Object.fromEntries(criteria.map((c, i) => [c.id, { score: scores[i][k], comment: `${name} on ${c.name}: a full sentence of evidence.` }])),
  }));
  const categoryAverages = criteria.map((c, i) => ({ id: c.id, name: c.name, maxScore: 5, average: Math.round((scores[i].reduce((a, b) => a + b, 0) / 3) * 10) / 10 }));
  return {
    sessionId: '5b15a6aa-1111-2222-3333-444455556666', teamId: 't', name: 'Aisha Tan', date: '2026-10-19', start: '09:00', end: '09:20',
    state: 'DECIDED', expected: 3, submitted: 3,
    average: Math.round((categoryAverages.reduce((a, c) => a + (c.average ?? 0), 0) / 5) * 10) / 10,
    categoryAverages, support: { yes: support.filter(Boolean).length, no: support.filter((x) => !x).length }, judges,
    decision: { status: 'SUBMITTED', decision: 'SELECTED', feedback: 'Clear, structured thinker.', decidedBy: 'HR Admin', decidedAt: new Date('2026-10-19T09:00:00Z') },
    report: null, reports: [], revision: 1, reopened: null, dayClosed: false,
  };
}

const data = (r: CandidateRecord): ReviewData => ({
  event: { id: 'e', name: 'October Graduate Interviews', timezone: 'Asia/Singapore', closed: false, closedAt: null, closedBy: null },
  criteria, scale: 'RATING', scoreMax: 5, supportQuestion: 'Support for LAP', maxTotal: 25, days: [], records: [r],
});

describe('candidate report PDF', () => {
  it('builds an A4 PDF for a decided candidate', async () => {
    const r = record([[5, 4, 5], [5, 5, 4], [4, 4, 5], [5, 4, 4], [4, 4, 5]], [true, true, true]);
    const pdf = await buildReportPdf(data(r), r);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(3);
  });

  it('names and references the file', () => {
    const r = record([[3, 3, 3], [3, 3, 3], [3, 3, 3], [3, 3, 3], [3, 3, 3]], [true, false, true]);
    expect(reportRef(r)).toBe('TD-261019-5B15A6');
    expect(reportFileName(r)).toBe('Aisha-Tan-2026-10-19-assessment.pdf');
  });

  it('tints rose, sand and sage by the average', () => {
    expect(scoreTone(1.9, 5).fill).toBe('#e5c1b8');
    expect(scoreTone(3, 5).fill).toBe('#eadbb8');
    expect(scoreTone(4.5, 5).fill).toBe('#c3d6c6');
  });
});
