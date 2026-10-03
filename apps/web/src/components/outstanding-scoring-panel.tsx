'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';

/**
 * Judges who owe scorecards for sessions that have already finished.
 *
 * Grouped by judge rather than by session on purpose — one judge with six
 * outstanding scorecards is one phone call, not six problems. Sorted oldest
 * first, so anything left from yesterday sits above this morning's.
 *
 * There is no hard stop anywhere in the platform. A judge who does not finish
 * on day one finishes on day two. This panel exists so a coordinator knows who
 * to chase, and it deliberately shows contact details rather than offering to
 * send anything — the platform never contacts judges directly.
 */

const OUTSTANDING_QUERY = `
  query Outstanding($eventId: String!) {
    outstandingScoring(eventId: $eventId) {
      judgeId judgeName judgeEmail judgePhone
      outstanding notStarted inProgress oldestSessionAt teams
    }
  }
`;

type Row = {
  judgeId: string;
  judgeName: string;
  judgeEmail: string;
  judgePhone?: string | null;
  outstanding: number;
  notStarted: number;
  inProgress: number;
  oldestSessionAt?: string | null;
  teams: string[];
};

/** "yesterday 10:15" reads better than a timestamp when chasing someone. */
function whenText(iso?: string | null) {
  if (!iso) return 'time unknown';
  const then = new Date(iso);
  const now = new Date();
  const time = then.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false });

  const days = Math.floor(
    (new Date(now.toDateString()).getTime() - new Date(then.toDateString()).getTime()) / 86400000,
  );
  if (days === 0) return `since ${time} today`;
  if (days === 1) return `since ${time} yesterday`;
  return `since ${then.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' })}`;
}

export default function OutstandingScoringPanel({ eventId }: { eventId?: string | null }) {
  const token = useAuthStore((s) => s.token);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!token || !eventId) {
      setRows([]);
      setLoading(false);
      return;
    }
    try {
      const res = await createClient(token)
        .query(OUTSTANDING_QUERY, { eventId })
        .toPromise();
      setRows(res.data?.outstandingScoring ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [token, eventId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  if (loading || rows.length === 0) return null;

  const total = rows.reduce((sum, r) => sum + r.outstanding, 0);

  return (
    <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.04]">
      <button type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left"
      >
        <span className="text-sm text-amber-300">
          {total} scorecard{total === 1 ? '' : 's'} outstanding
        </span>
        <span className="text-xs text-amber-300/60">
          across {rows.length} judge{rows.length === 1 ? '' : 's'} · sessions already finished
        </span>
        <span className="ml-auto text-xs text-amber-300/60">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="border-t border-amber-500/15 px-5 py-3 space-y-3">
          {rows.map((r) => (
            <div key={r.judgeId} className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white">
                  {r.judgeName}
                  <span className="ml-2 text-xs text-slate-400">
                    {r.judgeEmail}
                    {r.judgePhone && <span className="ml-2">{r.judgePhone}</span>}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {r.notStarted > 0 && `${r.notStarted} not opened`}
                  {r.notStarted > 0 && r.inProgress > 0 && ' · '}
                  {r.inProgress > 0 && `${r.inProgress} in progress`}
                  <span className="ml-2 text-slate-500">{whenText(r.oldestSessionAt)}</span>
                </p>
                <p className="mt-1 text-xs text-slate-500">{r.teams.join(' · ')}</p>
              </div>
              <span className="shrink-0 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-300">
                {r.outstanding}
              </span>
            </div>
          ))}
          <p className="border-t border-amber-500/15 pt-2 text-[11px] text-slate-500">
            Judges are not contacted automatically. Chase these directly — they can still
            score tomorrow if today runs out.
          </p>
        </div>
      )}
    </div>
  );
}
