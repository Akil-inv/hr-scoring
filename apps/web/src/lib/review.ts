'use client';

/**
 * Shared by the Review and Results pages: the API's shapes, the decision
 * labels and colours, and downloading the results workbook.
 */

export type Criterion = {
  id: string; name: string; parentId: string | null; minScore: number; maxScore: number; order: number;
  description: string | null; anchors: { score: number; label: string; text: string }[];
};
export type JudgeCard = {
  judgeId: string; name: string; excused: boolean; status: string; submitted: boolean; total: number | null;
  submittedAt: string | null; strengths: string | null; areasForImprovement: string | null; recommendation: string | null;
  support: boolean | null;
  scores: Record<string, { score: number | null; comment: string | null }>;
};
export type Decision = 'SELECTED' | 'WAITLIST' | 'NOT_SELECTED' | 'DID_NOT_ATTEND';
export type CandidateRecord = {
  sessionId: string; teamId: string; name: string; date: string; start: string; end: string;
  state: 'AWAITING' | 'READY' | 'DECIDED'; expected: number; submitted: number; average: number | null;
  categoryAverages: { id: string; name: string; maxScore: number; average: number | null }[];
  support: { yes: number; no: number };
  judges: JudgeCard[];
  decision: { status: 'DRAFT' | 'SUBMITTED'; decision: Decision | null; feedback: string | null; decidedBy: string | null; decidedAt: string | null } | null;
  report: { revision: number; createdAt: string } | null;
  reports: { revision: number; createdAt: string; supersededAt: string | null; supersededReason: string | null }[];
  revision: number;
  reopened: { at: string; by: string | null; reason: string | null } | null;
  dayClosed: boolean;
};
export type ReviewData = {
  event: { id: string; name: string; timezone: string; closed: boolean; closedAt: string | null; closedBy: string | null };
  criteria: Criterion[];
  scale: 'POINTS' | 'RATING';
  scoreMax: number;
  supportQuestion: string | null;
  maxTotal: number;
  days: { date: string; candidates: number; decided: number; ready: number; closed: boolean; closedAt: string | null; closedBy: string | null }[];
  records: CandidateRecord[];
};

export const DECISIONS: { value: Decision; label: string; tone: string; dot: string }[] = [
  { value: 'SELECTED', label: 'Selected', tone: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200', dot: 'bg-emerald-400' },
  { value: 'WAITLIST', label: 'Waitlist', tone: 'border-amber-400/40 bg-amber-400/10 text-amber-200', dot: 'bg-amber-400' },
  { value: 'NOT_SELECTED', label: 'Not selected', tone: 'border-slate-400/30 bg-white/[0.04] text-slate-300', dot: 'bg-slate-400' },
  { value: 'DID_NOT_ATTEND', label: 'Did not attend', tone: 'border-dashed border-slate-500/50 text-slate-400', dot: 'bg-slate-600' },
];
/** The three outcomes for a candidate who was interviewed. */
export const OUTCOMES = DECISIONS.filter((d) => d.value !== 'DID_NOT_ATTEND');

/** POST to the review API with the sign-in token; throws the server's message. */
export async function reviewAction(url: string, token: string | null, body: unknown = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.message === 'string' ? data.message : `Could not complete that (${res.status}).`);
  return data;
}

/** A stored report revision (earlier ones are superseded). */
export function fetchReportRevision(eventId: string, token: string | null, sessionId: string, revision: number) {
  return fetchPdfPublic(`/api/review/${eventId}/${sessionId}/report?view=1&revision=${revision}`, token);
}

export function decisionMeta(d: Decision | null | undefined) {
  return DECISIONS.find((x) => x.value === d) ?? null;
}

/** The submitted decision, or null while undecided. */
export function finalDecision(r: CandidateRecord): Decision | null {
  return r.decision?.status === 'SUBMITTED' ? r.decision.decision : null;
}

export function stateLabel(r: CandidateRecord): string {
  if (r.state === 'DECIDED') return decisionMeta(finalDecision(r))?.label ?? 'Decided';
  if (r.state === 'READY') return r.decision?.status === 'DRAFT' ? 'Ready · draft saved' : 'Ready for decision';
  return `Awaiting scores · ${r.submitted}/${r.expected}`;
}

/**
 * Pale rose to sand to sage by the share of the top score reached: the
 * colours used for the radar, scores and the PDF report.
 */
const FILL: [number, number[]][] = [[0.4, [229, 193, 184]], [0.6, [234, 219, 184]], [0.8, [195, 214, 198]]];
const LINE: [number, number[]][] = [[0.4, [160, 98, 86]], [0.6, [150, 120, 60]], [0.8, [78, 118, 90]]];
const TEXT: [number, number[]][] = [[0.4, [228, 160, 146]], [0.6, [222, 196, 140]], [0.8, [160, 205, 172]]];
function blend(stops: [number, number[]][], f: number) {
  let c: number[];
  if (f <= stops[0][0]) c = stops[0][1];
  else if (f >= stops[2][0]) c = stops[2][1];
  else {
    const k = f < stops[1][0] ? 0 : 1;
    const [a, ca] = stops[k];
    const [b, cb] = stops[k + 1];
    c = ca.map((x, i) => Math.round(x + (cb[i] - x) * ((f - a) / (b - a))));
  }
  return `rgb(${c.join(',')})`;
}
/** A score as shown: ratings to one decimal (3.0 of 5), points as they are. */
export function fmtScore(v: number | null | undefined, scale: 'POINTS' | 'RATING'): string {
  if (v === null || v === undefined) return '—';
  return scale === 'RATING' ? v.toFixed(1) : String(v);
}

/** fill/line for shapes and chips; text for a score shown on the dark app background. */
export function scoreTone(value: number | null | undefined, max: number) {
  const f = value === null || value === undefined || !max ? 0 : value / max;
  return { fill: blend(FILL, f), line: blend(LINE, f), text: blend(TEXT, f) };
}

async function download(url: string, token: string | null, fallback: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.message === 'string' ? body.message : `Download failed (${res.status}).`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallback;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

async function fetchPdf(url: string, token: string | null, init: RequestInit = {}): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.message === 'string' ? body.message : `Could not load the report (${res.status}).`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'report.pdf';
  return { blob: await res.blob(), name };
}

const fetchPdfPublic = (url: string, token: string | null) => fetchPdf(url, token);

/** The stored report, to show in the app. */
export function fetchReport(eventId: string, token: string | null, sessionId: string) {
  return fetchPdf(`/api/review/${eventId}/${sessionId}/report?view=1`, token);
}

/** A draft preview with the decision and comments as they stand (not stored). */
export function fetchReportPreview(
  eventId: string, token: string | null, sessionId: string, draft: { decision: string | null; feedback: string },
) {
  return fetchPdf(`/api/review/${eventId}/${sessionId}/report-preview`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
  });
}

/** The results workbook for one day, or all days. */
export function downloadResults(eventId: string, token: string | null, date?: string) {
  return download(`/api/review/${eventId}/export${date ? `?date=${date}` : ''}`, token, 'results.xlsx');
}

/** One candidate's stored assessment report (decided records only). */
export function downloadReport(eventId: string, token: string | null, sessionId: string) {
  return download(`/api/review/${eventId}/${sessionId}/report`, token, 'assessment.pdf');
}

/** Every decided candidate's report for a day, as a zip. */
export function downloadDayReports(eventId: string, token: string | null, date: string) {
  return download(`/api/review/${eventId}/reports?date=${date}`, token, 'reports.zip');
}
