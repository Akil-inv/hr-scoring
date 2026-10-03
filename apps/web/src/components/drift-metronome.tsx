'use client';

import { useMemo, useState } from 'react';

/**
 * Scoring drift indicator.
 *
 * Shows a judge the slant in their own scoring across a day — nothing more.
 * The arm leans right if their later scores run higher than their earlier
 * ones, left if lower.
 *
 * Deliberate design constraints, all of which came out of talking through
 * what this can honestly claim:
 *
 *   - Self-referential only. No comparison against other judges. A judge who
 *     scores lower than their peers may simply be more rigorous; a judge whose
 *     own scores slide across the day has changed something about how they are
 *     scoring, and only they can say whether that was warranted.
 *
 *   - A lean is not an error. If the afternoon teams were weaker, the lean is
 *     correct and the judge has just confirmed their own objectivity. The
 *     wording never suggests otherwise.
 *
 *   - Nothing is shown below MIN_SESSIONS. With two or three scorecards a
 *     single strong or weak team dominates the line, and a judge might
 *     "correct" toward a lean that was never there.
 *
 *   - Resets daily. A judge arriving fresh on day two has not inherited
 *     yesterday's fatigue.
 *
 *   - Computed on current values. If a judge revisits and revises an early
 *     score, the arm moves immediately — recalibration is the whole point.
 *
 *   - Never surfaced against a team. No team is ever labelled as having
 *     received drifted scores.
 */

type Scorecard = {
  sessionId: string;
  status: string;
  totalScore?: number | null;
};

type Session = {
  sessionId: string;
  date?: string | null;
  startTime?: string | null;
};

type Props = {
  scorecards: Scorecard[];
  sessions: Session[];
  /** Pixel height of the metronome. Below ~100 the tick marks are dropped. */
  size?: number;
};

const SUBMITTED = ['SUBMITTED', 'RESUBMITTED', 'LOCKED'];

/** Below this many submitted scores in a day, show nothing. */
const MIN_SESSIONS = 4;

/** Degrees of lean per point of total drift. */
const DEG_PER_POINT = 8 / 5;

/** Drift beyond this pins the arm — it is an indicator, not a measurement. */
const PIN_AT_POINTS = 20;

/**
 * Least-squares slope of y over its index, multiplied out to the total change
 * across the whole sequence. "I have drifted 10 points since this morning" is
 * something a judge can picture; "1.3 points per session" is not.
 */
function totalDrift(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0) return 0;

  return (num / den) * (n - 1);
}

function phrasing(drift: number, pinned: boolean): string {
  if (pinned) {
    return drift > 0
      ? 'Your scores have climbed a good deal since you started — worth a glance at your first few.'
      : 'Your scores have come down a good deal since you started — worth a glance at your first few.';
  }
  if (Math.abs(drift) < 3) return 'Your scoring has held steady today.';
  return drift > 0
    ? "Your scores have drifted a little higher as the day's gone on."
    : 'Your later scores are running a bit below your earlier ones.';
}

export default function DriftMetronome({ scorecards, sessions, size = 84 }: Props) {
  const state = useMemo(() => {
    // Sessions in the order the judge actually saw the teams — not the order
    // they happened to submit. A judge who writes up three scorecards over
    // lunch has not scored three teams in a burst.
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));

    const scored = scorecards
      .filter((sc) => SUBMITTED.includes(sc.status) && typeof sc.totalScore === 'number')
      .map((sc) => ({ sc, session: byId.get(sc.sessionId) }))
      .filter((r) => r.session?.startTime);

    if (scored.length < MIN_SESSIONS) return null;

    // Group by calendar day, then take the most recent day that has enough.
    const days = new Map<string, { t: number; score: number }[]>();
    for (const { sc, session } of scored) {
      const t = new Date(session!.startTime as string).getTime();
      const key = session!.date
        ? new Date(session!.date).toDateString()
        : new Date(t).toDateString();
      const list = days.get(key) ?? [];
      list.push({ t, score: sc.totalScore as number });
      days.set(key, list);
    }

    const eligible = [...days.entries()]
      .map(([key, rows]) => ({ key, rows: rows.sort((a, b) => a.t - b.t) }))
      .filter((d) => d.rows.length >= MIN_SESSIONS)
      .sort((a, b) => b.rows[0].t - a.rows[0].t);

    if (eligible.length === 0) return null;

    const rows = eligible[0].rows;
    const drift = totalDrift(rows.map((r) => r.score));
    const pinned = Math.abs(drift) > PIN_AT_POINTS;
    const clamped = Math.max(-PIN_AT_POINTS, Math.min(PIN_AT_POINTS, drift));

    return {
      angle: clamped * DEG_PER_POINT,
      pinned,
      count: rows.length,
      label: phrasing(drift, pinned),
      // The scores themselves, in the order the teams were seen.
      //
      // Without them a judge has a lean and no way to check it. Four identical
      // scores and one excellent team pins the arm — nothing drifted, but the
      // regression weights the last point heavily and the sentence alone
      // cannot say so. Shown, the 90 explains the lean in the same glance.
      // The two ends, not the whole day.
      //
      // Without any scores a judge has a lean and no way to check it: four
      // identical scores and one excellent team pins the arm, and the sentence
      // alone cannot say that nothing drifted. With all of them, twenty-seven
      // numbers wrap a 240px tooltip into a paragraph nobody reads.
      //
      // The ends are where a least-squares line is pulled hardest, so these
      // are the scores that moved the arm — and an outlier is still visible,
      // which is the point. Deliberately labelled "started" and "latest"
      // rather than "first three against last three": the fit uses every
      // point, and the tooltip should not claim otherwise.
      all: rows.map((r) => r.score),
    };
  }, [scorecards, sessions]);

  const [hover, setHover] = useState(false);

  if (!state) return null;

  const w = size * 0.62;
  const h = size;
  const pivotX = w / 2;
  const pivotY = h * 0.86;
  const armLength = h * 0.78;

  const rad = (state.angle * Math.PI) / 180;
  const tipX = pivotX + Math.sin(rad) * armLength;
  const tipY = pivotY - Math.cos(rad) * armLength;

  // Weight sits three-quarters up the arm.
  const wx = pivotX + Math.sin(rad) * armLength * 0.72;
  const wy = pivotY - Math.cos(rad) * armLength * 0.72;

  const armColor = state.pinned ? '#f97316' : '#94a3b8';
  const bodyColor = '#334155';

  return (
    <div
      className="relative shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={state.label}
        style={{ overflow: 'visible' }}
      >
        <line
          x1={pivotX}
          y1={pivotY}
          x2={tipX}
          y2={tipY}
          stroke={armColor}
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle cx={wx} cy={wy} r={size * 0.055} fill={armColor} />
        <polygon
          points={`${w * 0.08},${h * 0.9} ${w * 0.92},${h * 0.9} ${w * 0.72},${h * 0.3} ${w * 0.28},${h * 0.3}`}
          fill="none"
          stroke={bodyColor}
          strokeWidth={1}
          strokeLinejoin="round"
        />
        <circle cx={pivotX} cy={pivotY} r={2} fill={bodyColor} />
      </svg>

      {hover && (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-20 mt-2 w-60 rounded-lg border border-[#1e293b] bg-[#111827] px-3 py-2 text-xs leading-relaxed text-gray-300 shadow-xl"
        >
          {state.label}
          <span className="mt-1 block text-[11px] text-gray-500">
            {state.count < 6
              ? `All ${state.count} today: ${state.all.join(', ')}.`
              : `Started ${state.all.slice(0, 3).join(', ')} · latest ` +
                `${state.all.slice(-3).join(', ')} · ${state.count} scored today.`}
          </span>
        </div>
      )}
    </div>
  );
}
