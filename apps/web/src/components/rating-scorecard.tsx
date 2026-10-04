'use client';

/**
 * The judge's scorecard for a rating rubric (e.g. LAP: five dimensions rated
 * 1 to 5). Each dimension shows what a 1, 3 and 5 look like, five buttons, and
 * a roomy comment box; every rating needs a comment. Then the rubric's Yes /
 * No question (e.g. "Support for LAP"), when it has one.
 *
 * State lives in the judge page, which saves and autosaves it. This only
 * draws it and reports changes.
 */

export type RatingRow = {
  criterionId: string;
  criterionName: string;
  description?: string | null;
  minScore: number;
  maxScore: number;
  /** Finest step allowed: 1 for whole numbers, 0.25 to allow 3.75. */
  scoreIncrement?: number;
  requiresComment?: boolean;
  scoringAnchors?: { score: number; label: string; text: string }[] | string | null;
};

type Entry = { score: number | null; comment: string };

/** 3 → "3", 3.5 → "3.5", 3.75 → "3.75". */
export function showScore(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function anchorsOf(row: RatingRow): { score: number; label: string; text: string }[] {
  const raw = typeof row.scoringAnchors === 'string' ? JSON.parse(row.scoringAnchors) : row.scoringAnchors;
  return Array.isArray(raw) ? raw.filter((a) => typeof a?.score === 'number' && a?.text) : [];
}

/** Which described levels a score touches: 3 is Moderate, 4 sits between Moderate and High. */
function touches(score: number | null, anchors: { score: number }[]): Set<number> {
  if (score === null) return new Set();
  const exact = anchors.find((a) => a.score === score);
  if (exact) return new Set([exact.score]);
  const below = [...anchors].reverse().find((a) => a.score < score);
  const above = anchors.find((a) => a.score > score);
  return new Set([below?.score, above?.score].filter((n): n is number => n !== undefined));
}

export default function RatingScorecard({
  rows, scores, locked, engaged, supportQuestion, support, onScore, onComment, onSupport,
}: {
  rows: RatingRow[];
  scores: Record<string, Entry>;
  locked: boolean;
  /** Mark what is missing only once the judge has started (or pressed Submit). */
  engaged: boolean;
  supportQuestion: string | null;
  support: boolean | null;
  onScore: (criterionId: string, score: number) => void;
  onComment: (criterionId: string, comment: string) => void;
  onSupport: (value: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      {rows.map((row, i) => {
        const s = scores[row.criterionId] || { score: null, comment: '' };
        const anchors = anchorsOf(row);
        const lit = touches(s.score, anchors);
        const levels = Array.from({ length: row.maxScore - row.minScore + 1 }, (_, k) => row.minScore + k);
        const step = row.scoreIncrement && row.scoreIncrement < 1 ? row.scoreIncrement : 1;
        // The whole number a score belongs to: 3.75 sits in the 3 button.
        const band = s.score === null ? null : Math.floor(s.score + 1e-9);
        const scoreMissing = engaged && s.score === null;
        const commentMissing = engaged && row.requiresComment !== false && !(s.comment || '').trim();
        const between = s.score !== null && !anchors.some((a) => a.score === s.score) && lit.size === 2;
        const [lo, hi] = [...lit].sort((a, b) => a - b);

        return (
          <section key={row.criterionId} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900">{i + 1}. {row.criterionName}</h3>
              <span className="shrink-0 text-sm text-slate-500">{s.score === null ? 'not rated' : `${showScore(s.score)} / ${row.maxScore}`}</span>
            </div>
            {row.description && <p className="mt-0.5 text-sm text-slate-600">{row.description}</p>}

            <div className="mt-3 flex gap-2" role="radiogroup" aria-label={`${row.criterionName} rating`}>
              {levels.map((v) => {
                const chosen = band === v;
                return (
                  <button key={v} type="button" role="radio" aria-checked={chosen} disabled={locked}
                    onClick={() => { if (!chosen) onScore(row.criterionId, v); }}
                    className={`h-14 min-w-0 flex-1 rounded-lg border bg-white text-lg font-semibold tabular-nums text-slate-800 transition-colors disabled:cursor-not-allowed ${
                      chosen
                        ? 'border-slate-600'
                        : scoreMissing
                          ? 'border-red-300 bg-red-50 hover:border-slate-500'
                          : 'border-slate-300 hover:border-slate-500'
                    }`}>
                    {chosen ? showScore(s.score!) : v}
                  </button>
                );
              })}
            </div>
            {/* The fine-tune line, only under the chosen box: from that number
                up to just below the next (3 to 3.75). 5 is the top, so none. */}
            {step < 1 && (
              <div className="flex gap-2" aria-hidden={band === null}>
                {levels.map((v) => {
                  const top = Math.min(v + 1 - step, row.maxScore);
                  const show = band === v && top > v;
                  return (
                    <div key={v} className="min-w-0 flex-1 px-1">
                      {show ? (
                        <input type="range" className="fine-range" min={v} max={top} step={step} value={s.score!} disabled={locked}
                          aria-label={`${row.criterionName}: fine-tune between ${v} and ${showScore(top)}`}
                          onChange={(e) => onScore(row.criterionId, Math.round(Number(e.target.value) * 100) / 100)} />
                      ) : <div className="h-7" />}
                    </div>
                  );
                })}
              </div>
            )}
            {step < 1 && !locked && (
              <p className="text-xs text-slate-500">
                {s.score === null
                  ? `Tap a number. A line appears under it to fine-tune (e.g. ${row.minScore + 2}.75).`
                  : band !== null && band < row.maxScore
                    ? `Drag the line to fine-tune between ${band} and ${showScore(Math.min(band + 1 - step, row.maxScore))}.`
                    : `${row.maxScore} is the top of the scale.`}
              </p>
            )}
            {scoreMissing && <p className="mt-1.5 text-sm text-red-700">Choose a rating.</p>}

            {anchors.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {anchors.map((a) => (
                  <div key={a.score}
                    className={`flex gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                      lit.has(a.score) ? 'bg-slate-100 text-slate-900' : 'text-slate-500'
                    }`}>
                    <span className={`w-24 shrink-0 font-medium ${lit.has(a.score) ? 'text-slate-900' : 'text-slate-500'}`}>{a.score} · {a.label}</span>
                    <span>{a.text}</span>
                  </div>
                ))}
                {between && <p className="px-3 text-sm text-slate-600">{showScore(s.score!)} sits between {lo} and {hi}.</p>}
              </div>
            )}

            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor={`c-${row.criterionId}`}>
              Comments <span className="font-normal text-slate-500">{row.requiresComment !== false ? '(required)' : '(optional)'}</span>
            </label>
            <textarea id={`c-${row.criterionId}`} value={s.comment || ''} disabled={locked} rows={5}
              onChange={(e) => onComment(row.criterionId, e.target.value)}
              placeholder={row.requiresComment !== false ? 'What did you see or hear that supports this rating?' : 'Optional: anything worth noting on this dimension'}
              className={`mt-1.5 w-full resize-y rounded-lg border-2 bg-slate-50 px-4 py-3 text-base leading-relaxed text-slate-900 placeholder-slate-500 outline-none focus:bg-white disabled:opacity-60 ${
                commentMissing ? 'border-red-500 bg-red-50' : 'border-slate-200 focus:border-slate-900'
              }`}
              style={{ minHeight: 140 }} />
            {commentMissing && <p className="mt-1.5 text-sm text-red-700">Add a comment for this rating.</p>}
          </section>
        );
      })}

      {supportQuestion && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-900">{supportQuestion}</h3>
          <div className="mt-3 flex gap-3" role="radiogroup" aria-label={supportQuestion}>
            {[true, false].map((v) => (
              <button key={String(v)} type="button" role="radio" aria-checked={support === v} disabled={locked}
                onClick={() => onSupport(v)}
                className={`h-12 w-32 rounded-lg border text-lg font-semibold disabled:cursor-not-allowed ${
                  support === v
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : engaged && support === null
                      ? 'border-red-300 bg-red-50 text-slate-700'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-slate-500'
                }`}>
                {v ? 'Yes' : 'No'}
              </button>
            ))}
          </div>
          {engaged && support === null && <p className="mt-1.5 text-sm text-red-700">Choose Yes or No.</p>}
        </section>
      )}
    </div>
  );
}
