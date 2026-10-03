'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useEventId } from '@/lib/event-store';
import { dayLabel, messageOf } from '@/components/upload-common';
import {
  CandidateRecord, DECISIONS, Decision, ReviewData, decisionMeta, finalDecision, stateLabel,
} from '@/lib/review';

/**
 * Review: one candidate at a time, after their interview. Every judge's
 * scores and comments side by side, the consolidated score, and the HR
 * admin's feedback and decision. Submitting closes the record.
 */
export default function ReviewPage() {
  const eventId = useEventId();
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!eventId) return;
    const res = await fetch(`/api/review/${eventId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(messageOf(body, `Could not load the review (${res.status}).`)); return; }
    setError(null);
    setData(body);
    setDate((d) => d ?? body.days.find((x: any) => x.ready > 0)?.date ?? body.days[0]?.date ?? null);
  }, [eventId, token]);

  useEffect(() => { load(); }, [load]);

  const records = useMemo(() => (data?.records ?? []).filter((r) => r.date === date), [data, date]);
  const record = records.find((r) => r.sessionId === selected) ?? null;

  if (!eventId) return <p className="text-sm text-slate-400">Choose an event first.</p>;
  if (error) return <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-red-300">{error}</div>;
  if (!data) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-bold text-white">Review</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Read each candidate&apos;s scores and comments, then record your feedback and decision. Submitting closes the record.
        </p>
      </div>

      {data.days.length === 0 ? <p className="text-sm text-slate-400">No candidates have been placed yet.</p> : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
            {data.days.map((d) => {
              const active = d.date === date;
              return (
                <button key={d.date} type="button" onClick={() => { setDate(d.date); setSelected(null); }}
                  className={`shrink-0 rounded-xl border px-3.5 py-2 text-left transition-colors ${active ? 'border-accent bg-accent/15' : 'border-dark-600 bg-dark-800/60 hover:border-dark-400'}`}>
                  <span className={`block text-sm font-medium ${active ? 'text-white' : 'text-slate-300'}`}>{dayLabel(d.date)}</span>
                  <span className="block text-xs text-slate-400 tabular-nums">
                    {d.decided}/{d.candidates} decided{d.ready ? ` · ${d.ready} ready` : ''}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_2.4fr]">
            <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-2 h-fit max-h-[75vh] overflow-y-auto">
              {records.map((r) => <CandidateRow key={r.sessionId} r={r} active={r.sessionId === selected} onClick={() => setSelected(r.sessionId)} />)}
            </div>
            <div>
              {record
                ? <CandidateDetail key={record.sessionId} data={data} r={record} eventId={eventId} token={token} onSaved={load} />
                : <div className="rounded-xl border border-dark-600 bg-dark-800/40 p-10 text-center text-sm text-slate-400">Choose a candidate to review.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CandidateRow({ r, active, onClick }: { r: CandidateRecord; active: boolean; onClick: () => void }) {
  const meta = decisionMeta(finalDecision(r));
  const chip = r.state === 'DECIDED' ? meta?.tone ?? '' : r.state === 'READY' ? 'border-accent/40 bg-accent/10 text-violet-200' : 'border-dark-500 text-slate-400';
  return (
    <button type="button" onClick={onClick}
      className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${active ? 'bg-accent/15' : 'hover:bg-white/[0.03]'}`}>
      <span className="min-w-0">
        <span className="block text-sm text-white truncate">{r.name}</span>
        <span className="block text-xs text-slate-400 tabular-nums">{r.start}–{r.end}{r.average !== null ? ` · ${r.average}` : ''}</span>
      </span>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${chip}`}>{stateLabel(r)}</span>
    </button>
  );
}

function CandidateDetail({ data, r, eventId, token, onSaved }: {
  data: ReviewData; r: CandidateRecord; eventId: string; token: string | null; onSaved: () => void;
}) {
  const closed = r.state === 'DECIDED';
  const [decision, setDecision] = useState<Decision | null>(r.decision?.decision ?? null);
  const [feedback, setFeedback] = useState(r.decision?.feedback ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const save = async (submit: boolean) => {
    if (submit && !window.confirm(`Submit ${decisionMeta(decision)?.label ?? ''} for ${r.name}? The record closes and can't be changed.`)) return;
    setSaving(true);
    setMsg(null);
    const res = await fetch(`/api/review/${eventId}/${r.sessionId}/decision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, feedback, submit }),
    });
    const body = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setMsg({ tone: 'error', text: messageOf(body, 'Could not save.') }); return; }
    setMsg({ tone: 'ok', text: submit ? 'Decision submitted.' : 'Draft saved.' });
    onSaved();
  };

  const parents = new Set(data.criteria.map((c) => c.parentId).filter(Boolean));
  const categories = data.criteria.filter((c) => !c.parentId && parents.has(c.id));
  const rowsOf = (catId: string) => data.criteria.filter((c) => c.parentId === catId);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">{r.name}</h2>
            <p className="text-sm text-slate-400">{dayLabel(r.date)} · {r.start}–{r.end} · {r.judges.filter((j) => !j.excused).map((j) => j.name).join(', ')}</p>
            {finalDecision(r)
              ? <a href={`/report/${eventId}/${r.sessionId}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-violet-300 hover:text-white">Open report (PDF) ↗</a>
              : <span className="mt-1 inline-block text-xs text-slate-500">Report available once the final decision is submitted</span>}
          </div>
          <div className="text-right">
            <p className="text-3xl font-semibold text-white tabular-nums">{r.average ?? '—'}<span className="text-base text-slate-500"> / {data.maxTotal}</span></p>
            <p className="text-xs text-slate-400">average of {r.judges.filter((j) => j.submitted).length} judge{r.judges.filter((j) => j.submitted).length === 1 ? '' : 's'}</p>
          </div>
        </div>
        {r.categoryAverages.length > 0 && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {r.categoryAverages.map((c) => (
              <div key={c.id}>
                <div className="flex justify-between text-xs text-slate-400"><span className="truncate pr-2">{c.name}</span><span className="tabular-nums">{c.average ?? '—'} / {c.maxScore}</span></div>
                <div className="mt-1 h-1.5 rounded-full bg-white/[0.06]"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${c.average === null ? 0 : (c.average / c.maxScore) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {r.judges.map((j) => (
          <div key={j.judgeId} className={`rounded-xl border border-dark-600 bg-dark-800/60 p-4 ${j.excused ? 'opacity-60' : ''}`}>
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-white">{j.name}{j.excused && <span className="ml-2 text-xs font-normal text-slate-400">stepped out</span>}</h3>
              <span className="text-sm tabular-nums text-slate-300">
                {j.submitted ? <>{j.total} / {data.maxTotal}</> : <span className="text-amber-300">{j.status === 'NOT_STARTED' ? 'Not started' : 'Not submitted'}</span>}
              </span>
            </div>
            {(j.strengths || j.areasForImprovement || j.recommendation) && (
              <dl className="mt-3 space-y-2 text-sm">
                {j.strengths && <div><dt className="text-xs text-slate-400">Strengths</dt><dd className="text-slate-200">{j.strengths}</dd></div>}
                {j.areasForImprovement && <div><dt className="text-xs text-slate-400">Areas for improvement</dt><dd className="text-slate-200">{j.areasForImprovement}</dd></div>}
                {j.recommendation && <div><dt className="text-xs text-slate-400">Recommendation</dt><dd className="text-slate-200">{j.recommendation}</dd></div>}
              </dl>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-slate-400 hover:text-white">Scores by criterion</summary>
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {categories.map((cat) => (
                    <Fragment key={cat.id}>
                      <tr><td colSpan={2} className="pt-2 pb-1 font-medium text-slate-300">{cat.name}</td></tr>
                      {rowsOf(cat.id).map((row) => {
                        const s = j.scores[row.id];
                        return (
                          <tr key={row.id} className="align-top border-t border-dark-600/60">
                            <td className="py-1 pr-2 text-slate-400">{row.name}{s?.comment && <span className="block text-slate-300 italic">“{s.comment}”</span>}</td>
                            <td className="py-1 text-right tabular-nums text-slate-200 whitespace-nowrap">{s?.score ?? '—'} / {row.maxScore}</td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-5">
        <h3 className="text-sm font-semibold text-white mb-3">HR feedback and decision</h3>
        {closed ? (
          <div className="space-y-2 text-sm">
            <span className={`inline-block rounded-full border px-3 py-1 ${decisionMeta(finalDecision(r))?.tone}`}>{decisionMeta(finalDecision(r))?.label}</span>
            <p className="text-slate-200 whitespace-pre-wrap">{r.decision?.feedback}</p>
            <p className="text-xs text-slate-500">Decided by {r.decision?.decidedBy ?? 'unknown'}{r.decision?.decidedAt ? ` · ${new Date(r.decision.decidedAt).toLocaleString('en-SG', { timeZone: data.event.timezone })}` : ''}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 mb-3">
              {DECISIONS.map((d) => (
                <button key={d.value} type="button" onClick={() => setDecision(d.value)}
                  className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${decision === d.value ? d.tone : 'border-dark-500 text-slate-300 hover:border-dark-400'}`}>
                  {d.label}
                </button>
              ))}
            </div>
            <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={4}
              placeholder="Your feedback on this candidate"
              className="w-full rounded-lg bg-dark-700 border border-dark-500 px-3 py-2 text-sm text-white outline-none focus:border-accent/60" />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" disabled={saving} onClick={() => save(false)}
                className="px-4 py-2 rounded-lg border border-dark-500 text-sm text-slate-200 hover:border-accent/60 disabled:opacity-40">Save draft</button>
              <button type="button" disabled={saving || r.state !== 'READY' || !decision || !feedback.trim()} onClick={() => save(true)}
                className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/90 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed">Submit decision</button>
              {r.state === 'AWAITING' && <span className="text-xs text-amber-300">Waiting for {r.expected - r.submitted} judge{r.expected - r.submitted === 1 ? '' : 's'} to submit.</span>}
              {msg && <span className={`text-sm ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
