'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useEventId } from '@/lib/event-store';
import { dayLabel, messageOf } from '@/components/upload-common';
import { CandidateRecord, DECISIONS, ReviewData, downloadResults, finalDecision } from '@/lib/review';

/**
 * Results: candidates grouped by the HR decision, best consolidated score
 * first in each group, for one day or all days so far. Downloads the results
 * workbook (summary, raw judge scores, judge comments) and opens the
 * printable candidate reports.
 */
export default function ResultsPage() {
  const eventId = useEventId();
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | 'ALL'>('ALL');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!eventId) return;
    const res = await fetch(`/api/review/${eventId}/results`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(messageOf(body, `Could not load results (${res.status}).`)); return; }
    setError(null);
    setData(body);
  }, [eventId, token]);
  useEffect(() => { load(); }, [load]);

  const records = useMemo(() => (data?.records ?? []).filter((r) => date === 'ALL' || r.date === date), [data, date]);
  const groups = useMemo(() => [
    ...DECISIONS.map((d) => ({ key: d.value, label: d.label, dot: d.dot, rows: records.filter((r) => finalDecision(r) === d.value) })),
    { key: 'NONE', label: 'Not yet decided', dot: 'bg-slate-600', rows: records.filter((r) => !finalDecision(r)) },
  ], [records]);

  const download = async (which?: string) => {
    if (!eventId) return;
    setBusy(which ?? 'ALL');
    try { await downloadResults(eventId, token, which); } catch (e: any) { setError(e.message); }
    setBusy(null);
  };

  if (!eventId) return <p className="text-sm text-slate-400">Choose an event first.</p>;
  if (error) return <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-red-300">{error}</div>;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-white">Results</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {records.filter((r) => finalDecision(r)).length} of {records.length} candidates decided{date === 'ALL' ? ' across all days' : ` on ${dayLabel(date)}`}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2 shrink-0">
          {date !== 'ALL' && (
            <>
              {records.some((r) => finalDecision(r)) && <a href={`/report/${eventId}/day/${date}`} target="_blank" rel="noreferrer"
                className="px-3 py-2 rounded-lg border border-dark-500 text-sm text-slate-200 hover:border-accent/60">Reports for this day (PDF)</a>}
              <button type="button" disabled={!!busy} onClick={() => download(date)}
                className="px-3 py-2 rounded-lg border border-dark-500 text-sm text-slate-200 hover:border-accent/60 disabled:opacity-40">
                {busy === date ? 'Preparing…' : 'Download this day (Excel)'}
              </button>
            </>
          )}
          <button type="button" disabled={!!busy} onClick={() => download()}
            className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/90 text-white text-sm font-medium disabled:opacity-40">
            {busy === 'ALL' ? 'Preparing…' : 'Download all days (Excel)'}
          </button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
        {[{ date: 'ALL' as const, label: 'All days', sub: `${data.records.length} candidates` },
          ...data.days.map((d) => ({ date: d.date, label: dayLabel(d.date), sub: `${d.decided}/${d.candidates} decided` }))].map((d) => (
          <button key={d.date} type="button" onClick={() => setDate(d.date)}
            className={`shrink-0 rounded-xl border px-3.5 py-2 text-left transition-colors ${date === d.date ? 'border-accent bg-accent/15' : 'border-dark-600 bg-dark-800/60 hover:border-dark-400'}`}>
            <span className={`block text-sm font-medium ${date === d.date ? 'text-white' : 'text-slate-300'}`}>{d.label}</span>
            <span className="block text-xs text-slate-400 tabular-nums">{d.sub}</span>
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {groups.filter((g) => g.rows.length > 0).map((g) => (
          <section key={g.key} className="rounded-xl border border-dark-600 bg-dark-800/60">
            <h2 className="flex items-center gap-2 px-4 pt-3 pb-2 text-sm font-semibold text-white">
              <span className={`h-2 w-2 rounded-full ${g.dot}`} />{g.label}<span className="font-normal text-slate-400">({g.rows.length})</span>
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 text-left border-t border-dark-600">
                  <th className="font-medium px-4 py-2">Candidate</th>
                  <th className="font-medium px-2 py-2">Interview</th>
                  <th className="font-medium px-2 py-2">Panel</th>
                  <th className="font-medium px-2 py-2 text-right">Score</th>
                  <th className="font-medium px-2 py-2">HR feedback</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r: CandidateRecord) => (
                  <tr key={r.sessionId} className="border-t border-dark-600 align-top">
                    <td className="px-4 py-2 text-white">{r.name}</td>
                    <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{dayLabel(r.date)} · {r.start}</td>
                    <td className="px-2 py-2 text-slate-400">{r.judges.filter((j) => !j.excused).map((j) => j.name).join(', ')}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-white">{r.average ?? '—'}<span className="text-slate-500"> / {data.maxTotal}</span></td>
                    <td className="px-2 py-2 text-slate-300 max-w-md">
                      {finalDecision(r) ? <span className="line-clamp-2">{r.decision?.feedback}</span> : <span className="text-slate-500">{r.state === 'READY' ? 'Ready for decision' : `Awaiting scores (${r.submitted}/${r.expected})`}</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {finalDecision(r) && <a href={`/report/${eventId}/${r.sessionId}`} target="_blank" rel="noreferrer" className="text-xs text-violet-300 hover:text-white whitespace-nowrap">Report ↗</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
