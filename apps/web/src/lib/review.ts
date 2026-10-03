'use client';

/**
 * Shared by the Review and Results pages: the API's shapes, the decision
 * labels and colours, and downloading the results workbook.
 */

export type Criterion = { id: string; name: string; parentId: string | null; maxScore: number; order: number };
export type JudgeCard = {
  judgeId: string; name: string; excused: boolean; status: string; submitted: boolean; total: number | null;
  submittedAt: string | null; strengths: string | null; areasForImprovement: string | null; recommendation: string | null;
  scores: Record<string, { score: number | null; comment: string | null }>;
};
export type Decision = 'SELECTED' | 'WAITLIST' | 'NOT_SELECTED';
export type CandidateRecord = {
  sessionId: string; teamId: string; name: string; date: string; start: string; end: string;
  state: 'AWAITING' | 'READY' | 'DECIDED'; expected: number; submitted: number; average: number | null;
  categoryAverages: { id: string; name: string; maxScore: number; average: number | null }[];
  judges: JudgeCard[];
  decision: { status: 'DRAFT' | 'SUBMITTED'; decision: Decision | null; feedback: string | null; decidedBy: string | null; decidedAt: string | null } | null;
};
export type ReviewData = {
  event: { id: string; name: string; timezone: string };
  criteria: Criterion[];
  maxTotal: number;
  days: { date: string; candidates: number; decided: number; ready: number }[];
  records: CandidateRecord[];
};

export const DECISIONS: { value: Decision; label: string; tone: string; dot: string }[] = [
  { value: 'SELECTED', label: 'Selected', tone: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200', dot: 'bg-emerald-400' },
  { value: 'WAITLIST', label: 'Waitlist', tone: 'border-amber-400/40 bg-amber-400/10 text-amber-200', dot: 'bg-amber-400' },
  { value: 'NOT_SELECTED', label: 'Not selected', tone: 'border-slate-400/30 bg-white/[0.04] text-slate-300', dot: 'bg-slate-400' },
];

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

/** Fetch the results workbook with the sign-in token and hand it to the browser. */
export async function downloadResults(eventId: string, token: string | null, date?: string) {
  const res = await fetch(`/api/review/${eventId}/export${date ? `?date=${date}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body?.message === 'string' ? body.message : `Download failed (${res.status}).`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'results.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
