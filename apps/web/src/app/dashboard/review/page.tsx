'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { DocumentPasswordNotice } from '@/components/document-password';
import { useEventId } from '@/lib/event-store';
import { dayLabel, messageOf } from '@/components/upload-common';
import {
  CandidateRecord, Decision, JudgeCard, OUTCOMES, ReviewData, decisionMeta, fetchReport, fetchReportPreview, fetchReportRevision,
  finalDecision, fmtScore, reviewAction, scoreTone, stateLabel,
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
      <DocumentPasswordNotice />
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
                  <span className={`block text-sm font-medium ${active ? 'text-white' : 'text-slate-300'}`}>{d.closed ? '🔒 ' : ''}{dayLabel(d.date)}</span>
                  <span className="block text-xs text-slate-400 tabular-nums">
                    {d.closed ? 'Closed' : `${d.decided}/${d.candidates} decided${d.ready ? ` · ${d.ready} ready` : ''}`}
                  </span>
                </button>
              );
            })}
          </div>

          {date && <DayBar data={data} date={date} eventId={eventId} token={token} onChanged={load} />}

          <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_2.4fr]">
            <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-2 h-fit max-h-[75vh] overflow-y-auto">
              {records.map((r) => <CandidateRow key={r.sessionId} r={r} max={data.scoreMax} scale={data.scale} active={r.sessionId === selected} onClick={() => setSelected(r.sessionId)} />)}
            </div>
            <div>
              {record
                ? <CandidateDetail key={`${record.sessionId}-${record.revision}-${record.decision?.status ?? 'none'}`} data={data} r={record} eventId={eventId} token={token} onSaved={load} />
                : <div className="rounded-xl border border-dark-600 bg-dark-800/40 p-10 text-center text-sm text-slate-400">Choose a candidate to review.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The day's status and Close day. Closing needs every candidate decided or
 * marked Did not attend; it makes their reports, locks the scorecards and
 * stops the day's judge links.
 */
function DayBar({ data, date, eventId, token, onChanged }: {
  data: ReviewData; date: string; eventId: string; token: string | null; onChanged: () => void;
}) {
  const day = data.days.find((d) => d.date === date);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!day) return null;
  const left = day.candidates - day.decided;
  const close = async () => {
    const open = day.openInterviews ?? 0;
    const finishing = open > 0
      ? `\n\n${open} interview${open === 1 ? ' is' : 's are'} still open in the Command Center. Closing the day marks ${open === 1 ? 'it' : 'them'} Completed (Did not attend: Cancelled).`
      : '';
    if (!window.confirm(`Close ${dayLabel(date)}? Its scorecards lock and its judge links stop working. A single interview can still be reopened later with a reason.${finishing}`)) return;
    setBusy(true); setMsg(null);
    try { await reviewAction(`/api/review/${eventId}/days/${date}/close`, token); onChanged(); }
    catch (e: any) { setMsg(e.message); }
    setBusy(false);
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-dark-600 bg-dark-800/60 px-4 py-3">
      {day.closed ? (
        <p className="text-sm text-slate-300">
          <span className="font-medium text-white">{dayLabel(date)} is closed.</span>{' '}
          Closed by {day.closedBy ?? 'unknown'}{day.closedAt ? ` · ${new Date(day.closedAt).toLocaleString('en-SG', { timeZone: data.event.timezone })}` : ''}.
          {' '}Scorecards are locked and the day&apos;s judge links no longer score.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-300">
            <span className="font-medium text-white">{day.decided} of {day.candidates}</span> decided on {dayLabel(date)}.
            {left > 0 ? ` ${left} still need a final decision (or Did not attend) before the day can close.` : ' Every candidate is decided.'}
            {left === 0 && (day.openInterviews ?? 0) > 0 && (
              <span className="text-slate-400"> {day.openInterviews} interview{day.openInterviews === 1 ? ' is' : 's are'} still open in the Command Center; closing the day completes {day.openInterviews === 1 ? 'it' : 'them'}.</span>
            )}
          </p>
          {!data.event.closed && (
            <button type="button" onClick={close} disabled={busy || left > 0}
              title={left > 0 ? 'Decide every candidate first' : undefined}
              className="ml-auto rounded-lg border border-dark-500 px-3 py-2 text-sm text-slate-200 hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? 'Closing…' : 'Close day'}
            </button>
          )}
        </>
      )}
      {msg && <p className="w-full text-sm text-red-300">{msg}</p>}
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
  const [viewing, setViewing] = useState<null | 'report' | 'preview' | number>(null);
  const [reopening, setReopening] = useState(false);
  const absent = decision === 'DID_NOT_ATTEND';
  const readOnly = data.event.closed;
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [tried, setTried] = useState(false);

  const save = async (submit: boolean) => {
    if (submit) {
      setTried(true);
      if (!decision || (!absent && !feedback.trim())) return;
      if (!window.confirm(absent
        ? `Mark ${r.name} as Did not attend? The record closes; there is no report.`
        : `Submit ${decisionMeta(decision)?.label ?? ''} for ${r.name}? This is final: the record closes and the PDF report is made.`)) return;
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
  const missingComment = tried && !absent && !feedback.trim();
  const superseded = r.reports.filter((x) => x.supersededAt);

  return (
    <div className="space-y-4">
      {r.reopened && !closed && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          <span className="font-medium">Decision reopened for revision</span> {new Date(r.reopened.at).toLocaleString('en-SG', { timeZone: data.event.timezone })}
          {r.reopened.by ? ` by ${r.reopened.by}` : ''}: {r.reopened.reason}. The panel&apos;s scores are final; submit the revised decision to make revision {r.revision} of the report.
        </div>
      )}
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
            <div className="flex shrink-0 gap-2">
              {finalDecision(r) !== 'DID_NOT_ATTEND' && (
                <button type="button" onClick={() => setViewing('report')}
                  className="rounded-lg border border-dark-500 px-3 py-2 text-sm text-slate-200 hover:border-accent/60">
                  View report (PDF)
                </button>
              )}
              {!readOnly && (
                <button type="button" onClick={() => setReopening((v) => !v)}
                  className="rounded-lg border border-dark-500 px-3 py-2 text-sm text-slate-200 hover:border-amber-400/60">
                  Revise decision…
                </button>
              )}
            </div>
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
              {OUTCOMES.map((d) => (
                <button key={d.value} type="button" onClick={() => setDecision(d.value)}
                  className={`rounded-lg border px-4 py-2.5 text-sm transition-colors ${decision === d.value ? d.tone : missingDecision ? 'border-red-400/50 text-slate-300' : 'border-dark-500 text-slate-300 hover:border-dark-400'}`}>
                  {d.label}
                </button>
              ))}
            </div>
            {missingDecision && <p className="mt-1 text-xs text-red-300">Choose a decision.</p>}
            {!r.judges.some((j) => j.submitted) && (
              <button type="button" onClick={() => setDecision(absent ? null : 'DID_NOT_ATTEND')}
                className={`mt-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${absent ? 'border-slate-400 text-white' : 'border-dashed border-dark-500 text-slate-400 hover:text-slate-200'}`}>
                {absent ? '✓ Did not attend' : 'Mark as did not attend'}
              </button>
            )}
            <label className="mt-4 block text-xs text-slate-400" htmlFor="hr-comments">HR comments{absent ? ' (optional)' : ''}</label>
            <textarea id="hr-comments" value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={5}
              placeholder="Your assessment and the reason for the decision"
              className={`mt-1 w-full rounded-lg bg-dark-700 border px-3 py-2 text-sm leading-relaxed text-white outline-none focus:border-accent/60 ${missingComment ? 'border-red-400/60' : 'border-dark-500'}`} />
            {missingComment && <p className="mt-1 text-xs text-red-300">Add your comments.</p>}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
              {r.state === 'AWAITING' && !absent && <span className="mr-auto text-xs text-amber-300">Waiting for {r.expected - r.submitted} judge{r.expected - r.submitted === 1 ? '' : 's'} to submit.</span>}
              {msg && <span className={`mr-auto text-sm ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</span>}
              <button type="button" disabled={saving} onClick={() => save(false)}
                className="px-4 py-2 rounded-lg border border-dark-500 text-sm text-slate-200 hover:border-accent/60 disabled:opacity-40">Save draft</button>
              <button type="button" disabled={saving || readOnly || (!absent && r.state !== 'READY')} onClick={() => save(true)}
                className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/90 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed">Submit final decision</button>
            </div>
          </>
        )}
        {closed && msg && <p className={`mt-2 text-sm ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</p>}
        {closed && reopening && (
          <ReopenForm r={r} eventId={eventId} token={token} onDone={() => { setReopening(false); onSaved(); }} onCancel={() => setReopening(false)} />
        )}
        {superseded.length > 0 && (
          <div className="mt-4 border-t border-dark-600 pt-3">
            <p className="text-xs text-slate-400">Earlier reports</p>
            <ul className="mt-1 space-y-1">
              {superseded.map((x) => (
                <li key={x.revision} className="flex flex-wrap items-baseline gap-x-2 text-sm text-slate-300">
                  <span>Revision {x.revision}</span>
                  <span className="text-xs text-slate-500">
                    superseded {new Date(x.supersededAt!).toLocaleString('en-SG', { timeZone: data.event.timezone })}{x.supersededReason ? `: ${x.supersededReason}` : ''}
                  </span>
                  <button type="button" onClick={() => setViewing(x.revision)} className="text-xs text-violet-300 hover:text-white">View</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {viewing && (
        <PdfViewer
          title={typeof viewing === 'number' ? `${r.name} — revision ${viewing}` : viewing === 'report' ? `${r.name} — assessment report` : `${r.name} — preview`}
          subtitle={typeof viewing === 'number' ? 'Superseded: kept for the record' : viewing === 'report' ? 'The stored report, as decided' : 'Draft: your decision and comments as they are now. Nothing is saved.'}
          load={() => typeof viewing === 'number'
            ? fetchReportRevision(eventId, token, r.sessionId, viewing)
            : viewing === 'report'
              ? fetchReport(eventId, token, r.sessionId)
              : fetchReportPreview(eventId, token, r.sessionId, { decision, feedback })}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/**
 * Revise HR's decision on a decided candidate. The judges' scores are final;
 * only the decision and comments reopen, as the next revision. The current
 * report is kept, marked superseded. A reason is required and recorded.
 */
function ReopenForm({ r, eventId, token, onDone, onCancel }: {
  r: CandidateRecord; eventId: string; token: string | null; onDone: () => void; onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!reason.trim()) { setErr('Give a reason. It is kept on the record.'); return; }
    setBusy(true); setErr(null);
    try { await reviewAction(`/api/review/${eventId}/${r.sessionId}/reopen`, token, { reason, judgeIds: [] }); onDone(); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-4">
      <p className="text-sm font-medium text-white">Revise the decision on {r.name}</p>
      <p className="mt-0.5 text-xs text-slate-400">
        The panel&apos;s scores and comments stay final. Your decision and comments go back to a draft as revision {r.revision + 1};
        this report is kept, marked superseded, and a new one is made when you submit.
      </p>
      <label className="mt-3 block text-xs text-slate-400" htmlFor="reopen-reason">Reason</label>
      <textarea id="reopen-reason" value={reason} onChange={(e) => { setReason(e.target.value); setErr(null); }} rows={2}
        placeholder="e.g. Change of decision after the calibration meeting"
        className="mt-1 w-full rounded-lg border border-dark-500 bg-dark-700 px-3 py-2 text-sm text-white outline-none focus:border-accent/60" />
      {err && <p className="mt-2 text-sm text-red-300">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-dark-500 px-3 py-2 text-sm text-slate-300">Cancel</button>
        <button type="button" onClick={go} disabled={busy} className="rounded-lg bg-amber-500/90 px-3 py-2 text-sm font-medium text-dark-900 hover:bg-amber-400 disabled:opacity-40">
          {busy ? 'Reopening…' : 'Revise decision'}
        </button>
      </div>
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
