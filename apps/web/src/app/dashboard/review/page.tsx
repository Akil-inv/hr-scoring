'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useEventId } from '@/lib/event-store';
import { dayLabel, messageOf } from '@/components/upload-common';
import {
  CandidateRecord, DECISIONS, Decision, JudgeCard, ReviewData, decisionMeta, fetchReport, fetchReportPreview, finalDecision, fmtScore, scoreTone, stateLabel,
} from '@/lib/review';
import ScoreRadar from '@/components/score-radar';
import PdfViewer from '@/components/pdf-viewer';

/**
 * Review: one candidate at a time, after their interview. The panel's
 * average and profile, every judge's scores and comments, and HR's decision
 * and comments. Submitting the decision closes the record and makes the
 * candidate's PDF report.
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
          Read the panel&apos;s scores and comments, then record your decision and comments. Submitting closes the record and makes the candidate&apos;s PDF report.
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
              {records.map((r) => <CandidateRow key={r.sessionId} r={r} max={data.scoreMax} scale={data.scale} active={r.sessionId === selected} onClick={() => setSelected(r.sessionId)} />)}
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

function CandidateRow({ r, max, scale, active, onClick }: { r: CandidateRecord; max: number; scale: ReviewData['scale']; active: boolean; onClick: () => void }) {
  const meta = decisionMeta(finalDecision(r));
  const chip = r.state === 'DECIDED' ? meta?.tone ?? '' : r.state === 'READY' ? 'border-accent/40 bg-accent/10 text-violet-200' : 'border-dark-500 text-slate-400';
  return (
    <button type="button" onClick={onClick}
      className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${active ? 'bg-accent/15' : 'hover:bg-white/[0.03]'}`}>
      <span className="min-w-0">
        <span className="block text-sm text-white truncate">{r.name}</span>
        <span className="block text-xs text-slate-400 tabular-nums">
          {r.start}–{r.end}
          {r.average !== null && <> · <span style={{ color: scoreTone(r.average, max).text }}>{fmtScore(r.average, scale)} / {max}</span></>}
        </span>
      </span>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${chip}`}>{stateLabel(r)}</span>
    </button>
  );
}

function ScoreChip({ value, max }: { value: number | null | undefined; max: number }) {
  if (value === null || value === undefined) return <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-md border border-dark-500 px-1.5 text-xs text-slate-500">–</span>;
  const t = scoreTone(value, max);
  return (
    <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-md px-1.5 text-xs font-semibold tabular-nums"
      style={{ background: t.fill, color: 'rgb(31,35,44)' }}>{value}</span>
  );
}

function CandidateDetail({ data, r, eventId, token, onSaved }: {
  data: ReviewData; r: CandidateRecord; eventId: string; token: string | null; onSaved: () => void;
}) {
  const closed = r.state === 'DECIDED';
  const rating = data.scale === 'RATING';
  const [decision, setDecision] = useState<Decision | null>(r.decision?.decision ?? null);
  const [feedback, setFeedback] = useState(r.decision?.feedback ?? '');
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<null | 'report' | 'preview'>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tried, setTried] = useState(false);

  const save = async (submit: boolean) => {
    if (submit) {
      setTried(true);
      if (!decision || !feedback.trim()) return;
      if (!window.confirm(`Submit ${decisionMeta(decision)?.label ?? ''} for ${r.name}? This is final: the record closes and the PDF report is made.`)) return;
    }
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
    setMsg({ tone: 'ok', text: submit ? 'Decision submitted. The report is ready.' : 'Draft saved.' });
    onSaved();
  };


  const scored = r.judges.filter((j) => j.submitted);
  const tone = scoreTone(r.average, data.scoreMax);
  const parents = new Set(data.criteria.map((c) => c.parentId).filter(Boolean));
  const leaves = data.criteria.filter((c) => !parents.has(c.id));
  const categories = data.criteria.filter((c) => !c.parentId && parents.has(c.id));
  const rowsOf = (catId: string) => data.criteria.filter((c) => c.parentId === catId);
  const missingDecision = tried && !decision;
  const missingComment = tried && !feedback.trim();

  return (
    <div className="space-y-4">
      {/* Summary: who, the average, the support question, and the profile. */}
      <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,360px)] md:items-center">
          <div>
            <h2 className="text-lg font-semibold text-white">{r.name}</h2>
            <p className="text-sm text-slate-400">{dayLabel(r.date)} · {r.start}–{r.end} · {r.judges.filter((j) => !j.excused).map((j) => j.name).join(', ')}</p>
            <div className="mt-4 flex flex-wrap gap-8">
              <div>
                <p className="text-xs text-slate-400">{rating ? 'Average rating' : 'Average score'}</p>
                <p className="text-3xl font-semibold tabular-nums" style={{ color: r.average === null ? undefined : tone.text }}>
                  {fmtScore(r.average, data.scale)}<span className="text-base font-normal text-slate-500"> / {data.scoreMax}</span>
                </p>
                <p className="text-xs text-slate-500">{scored.length} of {r.expected} judge{r.expected === 1 ? '' : 's'} submitted</p>
              </div>
              {data.supportQuestion && (
                <div>
                  <p className="text-xs text-slate-400">{data.supportQuestion}</p>
                  <p className="text-3xl font-semibold text-white tabular-nums">{r.support.yes}<span className="text-base font-normal text-slate-500"> of {scored.length} Yes</span></p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {r.judges.filter((j) => j.submitted).map((j) => (
                      <span key={j.judgeId} className="rounded-full px-2 py-0.5 text-[11px]"
                        style={j.support === true ? { background: 'rgb(195,214,198)', color: 'rgb(48,80,58)' } : j.support === false ? { background: 'rgb(229,193,184)', color: 'rgb(120,62,52)' } : {}}>
                        {j.name} · {j.support === true ? 'Yes' : j.support === false ? 'No' : '–'}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          {r.categoryAverages.length >= 3 && (
            <ScoreRadar
              axes={r.categoryAverages.map((c) => ({ id: c.id, name: c.name, value: c.average, max: c.maxScore }))}
              average={r.average} max={data.scoreMax} rings={rating ? data.scoreMax : 5} size={220} fmt={(v) => fmtScore(v, data.scale)} />
          )}
        </div>
      </div>

      {/* The panel's scores and comments. */}
      {rating ? (
        <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-5">
          <h3 className="text-sm font-semibold text-white">Panel scores and comments</h3>
          {r.judges.some((j) => !j.submitted && !j.excused) && (
            <p className="mt-1 text-xs text-amber-300">
              Still to submit: {r.judges.filter((j) => !j.submitted && !j.excused).map((j) => j.name).join(', ')}
            </p>
          )}
          <div className="mt-2 divide-y divide-dark-600">
            {leaves.map((l) => {
              const avg = r.categoryAverages.find((c) => c.id === l.id)?.average ?? null;
              return (
                <div key={l.id} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-white">{l.name}</span>
                    <span className="text-xs text-slate-400">average <span className="font-semibold tabular-nums" style={{ color: scoreTone(avg, l.maxScore).text }}>{fmtScore(avg, data.scale)}</span></span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {r.judges.map((j) => (
                      <div key={j.judgeId} className={`grid grid-cols-[88px_40px_minmax(0,1fr)] items-start gap-2 text-sm ${j.excused ? 'opacity-50' : ''}`}>
                        <span className="truncate text-slate-400 leading-6">{j.name}</span>
                        <ScoreChip value={j.submitted ? j.scores[l.id]?.score : null} max={l.maxScore} />
                        <span className="leading-6 text-slate-200 whitespace-pre-wrap">
                          {j.submitted ? (j.scores[l.id]?.comment || '—') : <span className="text-slate-500">{j.excused ? 'Stepped out' : 'Not submitted yet'}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {r.judges.map((j) => <PointsJudgeCard key={j.judgeId} j={j} data={data} categories={categories} rowsOf={rowsOf} />)}
        </div>
      )}

      {/* HR's decision and comments: the only verdict. */}
      <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">HR decision</h3>
            <p className="text-xs text-slate-400">{closed ? 'Final. This record is closed.' : 'Final once submitted. Submitting closes the record and makes the PDF report.'}</p>
          </div>
          {closed ? (
            <button type="button" onClick={() => setViewing('report')}
              className="shrink-0 rounded-lg border border-dark-500 px-3 py-2 text-sm text-slate-200 hover:border-accent/60">
              View report (PDF)
            </button>
          ) : (
            <button type="button" onClick={() => setViewing('preview')}
              title="See the report with your decision and comments as they are now. Nothing is saved."
              className="shrink-0 rounded-lg border border-dark-500 px-3 py-2 text-sm text-slate-200 hover:border-accent/60">
              Preview report
            </button>
          )}
        </div>
        {closed ? (
          <div className="mt-3 space-y-2 text-sm">
            <span className={`inline-block rounded-full border px-3 py-1 ${decisionMeta(finalDecision(r))?.tone}`}>{decisionMeta(finalDecision(r))?.label}</span>
            <p className="text-slate-200 whitespace-pre-wrap">{r.decision?.feedback}</p>
            <p className="text-xs text-slate-500">Decided by {r.decision?.decidedBy ?? 'unknown'}{r.decision?.decidedAt ? ` · ${new Date(r.decision.decidedAt).toLocaleString('en-SG', { timeZone: data.event.timezone })}` : ''}</p>
          </div>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {DECISIONS.map((d) => (
                <button key={d.value} type="button" onClick={() => setDecision(d.value)}
                  className={`rounded-lg border px-4 py-2.5 text-sm transition-colors ${decision === d.value ? d.tone : missingDecision ? 'border-red-400/50 text-slate-300' : 'border-dark-500 text-slate-300 hover:border-dark-400'}`}>
                  {d.label}
                </button>
              ))}
            </div>
            {missingDecision && <p className="mt-1 text-xs text-red-300">Choose a decision.</p>}
            <label className="mt-4 block text-xs text-slate-400" htmlFor="hr-comments">HR comments</label>
            <textarea id="hr-comments" value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={5}
              placeholder="Your assessment and the reason for the decision"
              className={`mt-1 w-full rounded-lg bg-dark-700 border px-3 py-2 text-sm leading-relaxed text-white outline-none focus:border-accent/60 ${missingComment ? 'border-red-400/60' : 'border-dark-500'}`} />
            {missingComment && <p className="mt-1 text-xs text-red-300">Add your comments.</p>}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
              {r.state === 'AWAITING' && <span className="mr-auto text-xs text-amber-300">Waiting for {r.expected - r.submitted} judge{r.expected - r.submitted === 1 ? '' : 's'} to submit.</span>}
              {msg && <span className={`mr-auto text-sm ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</span>}
              <button type="button" disabled={saving} onClick={() => save(false)}
                className="px-4 py-2 rounded-lg border border-dark-500 text-sm text-slate-200 hover:border-accent/60 disabled:opacity-40">Save draft</button>
              <button type="button" disabled={saving || r.state !== 'READY'} onClick={() => save(true)}
                className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/90 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed">Submit final decision</button>
            </div>
          </>
        )}
        {closed && msg && <p className={`mt-2 text-sm ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</p>}
      </div>

      {viewing && (
        <PdfViewer
          title={viewing === 'report' ? `${r.name} — assessment report` : `${r.name} — preview`}
          subtitle={viewing === 'report' ? 'The stored report, as decided' : 'Draft: your decision and comments as they are now. Nothing is saved.'}
          load={() => viewing === 'report'
            ? fetchReport(eventId, token, r.sessionId)
            : fetchReportPreview(eventId, token, r.sessionId, { decision, feedback })}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/** Points rubrics (hackathon style): each judge's card with strengths and criterion scores. */
function PointsJudgeCard({ j, data, categories, rowsOf }: {
  j: JudgeCard; data: ReviewData; categories: ReviewData['criteria']; rowsOf: (id: string) => ReviewData['criteria'];
}) {
  return (
    <div className={`rounded-xl border border-dark-600 bg-dark-800/60 p-4 ${j.excused ? 'opacity-60' : ''}`}>
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
                  const sc = j.scores[row.id];
                  return (
                    <tr key={row.id} className="align-top border-t border-dark-600/60">
                      <td className="py-1 pr-2 text-slate-400">{row.name}{sc?.comment && <span className="block text-slate-300 italic">“{sc.comment}”</span>}</td>
                      <td className="py-1 text-right tabular-nums text-slate-200 whitespace-nowrap">{sc?.score ?? '—'} / {row.maxScore}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
