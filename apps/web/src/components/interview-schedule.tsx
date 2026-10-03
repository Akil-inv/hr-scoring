'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { IssueList, dayLabel, messageOf, type Issue } from '@/components/upload-common';

/**
 * The interview schedule of an uploaded event.
 *
 * Each judging day shows its blocks (AM, PM) as they run: interviews, the
 * break and calibration, each interview with its panel. Candidates are added
 * from the candidates file in batches, and moved by dragging onto another
 * slot on the same day (dropping on an occupied slot swaps the two) or with
 * "Move to…" for another day. A day's panels can be locked once settled.
 */

type Panel = { judgeId: string; name: string };
type Candidate = { sessionId: string; teamId: string; name: string; started: boolean };
type Slot = {
  id: string; date: string; block: string | null; sequence: number | null;
  kind: 'INTERVIEW' | 'BREAK' | 'CALIBRATION'; start: string; end: string;
  panel: Panel[]; candidate: Candidate | null;
};
type Day = { date: string; status: 'OPEN' | 'CLOSED'; panelsLocked: boolean; blocks: { block: string; slots: Slot[] }[] };
type Schedule = {
  event: { id: string; name: string; timezone: string; minPanel: number };
  days: Day[];
  totals: { interviews: number; withPanel: number; placed: number };
};
type CandidatePreview = {
  ok: boolean; errors: Issue[]; warnings: Issue[];
  actions: { row: number | null; name: string; action: 'ADD' | 'MOVE' | 'UNCHANGED'; from: string | null; to: string }[];
  counts: { add: number; move: number; unchanged: number };
};

const CANDIDATES_TEMPLATE = '/templates/candidates-template.xlsx';

export default function InterviewSchedule({ eventId }: { eventId: string }) {
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<Schedule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [moving, setMoving] = useState<Candidate | null>(null);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`/api/interview-schedule/${eventId}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }, [eventId, token]);

  const load = useCallback(async () => {
    const { res, body } = await api('');
    if (!res.ok) { setLoadError(messageOf(body, `Could not load the schedule (${res.status}).`)); return; }
    setLoadError(null);
    setData(body);
    setActiveDate((d) => d && body.days.some((x: Day) => x.date === d) ? d : body.days[0]?.date ?? null);
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const flash = (tone: 'ok' | 'error', text: string) => {
    setNotice({ tone, text });
    if (tone === 'ok') setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 4000);
  };

  const moveTo = async (sessionId: string, toSlotId: string) => {
    setBusy(true);
    const { res, body } = await api('/move', { method: 'POST', body: JSON.stringify({ sessionId, toSlotId }) });
    setBusy(false);
    setMoving(null);
    if (!res.ok) { flash('error', messageOf(body, 'That move was refused.')); return; }
    const moved = (body.actions ?? []).filter((a: any) => a.action !== 'UNCHANGED');
    flash('ok', moved.map((a: any) => `${a.name} → ${a.to}`).join(' · ') || 'Nothing to change.');
    load();
  };

  const toggleLock = async (day: Day) => {
    setBusy(true);
    const { res, body } = await api('/lock', { method: 'POST', body: JSON.stringify({ date: day.date, locked: !day.panelsLocked }) });
    setBusy(false);
    if (!res.ok) { flash('error', messageOf(body, 'Could not change the lock.')); return; }
    flash('ok', `${dayLabel(day.date)}: panels ${day.panelsLocked ? 'unlocked' : 'locked'}.`);
    load();
  };

  const day = data?.days.find((d) => d.date === activeDate) ?? null;

  /** Free interview slots with a panel, across all open days: targets for "Move to…". */
  const freeSlots = useMemo(() => (data?.days ?? [])
    .filter((d) => d.status === 'OPEN')
    .flatMap((d) => d.blocks.flatMap((b) => b.slots))
    .filter((s) => s.kind === 'INTERVIEW' && s.panel.length > 0 && !s.candidate), [data]);

  if (loadError) return <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-red-300">{loadError}</div>;
  if (!data) return <p className="text-sm text-slate-400">Loading the schedule…</p>;

  const dayCounts = (d: Day) => {
    const iv = d.blocks.flatMap((b) => b.slots).filter((s) => s.kind === 'INTERVIEW' && s.panel.length > 0);
    return { placed: iv.filter((s) => s.candidate).length, total: iv.length };
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-white">Interview schedule</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {data.totals.placed} of {data.totals.withPanel} interview slots filled · {data.days.length} judging days · {data.event.timezone}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a href={CANDIDATES_TEMPLATE} download
            className="px-3 py-2 rounded-lg border border-dark-500 text-sm text-slate-200 hover:border-accent/60 transition-colors">
            Candidates template
          </a>
          <button type="button" onClick={() => setShowUpload((v) => !v)}
            className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/90 text-white text-sm font-medium shadow-lg shadow-accent/20">
            {showUpload ? 'Close' : 'Upload candidates'}
          </button>
        </div>
      </div>

      {showUpload && <CandidateUpload api={api} onDone={(msg) => { setShowUpload(false); flash('ok', msg); load(); }} />}

      {notice && (
        <div className={`mb-4 rounded-xl border px-4 py-2.5 text-sm ${notice.tone === 'ok' ? 'border-success/30 bg-success/10 text-emerald-200' : 'border-error/30 bg-error/10 text-red-200'}`}>
          {notice.text}
          {notice.tone === 'error' && <button type="button" onClick={() => setNotice(null)} className="ml-3 text-xs underline">dismiss</button>}
        </div>
      )}

      {data.days.length === 0 ? (
        <p className="text-sm text-slate-400">No judging days. Upload the setup workbook first.</p>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
            {data.days.map((d) => {
              const c = dayCounts(d);
              const active = d.date === activeDate;
              return (
                <button key={d.date} type="button" onClick={() => setActiveDate(d.date)}
                  className={`shrink-0 rounded-xl border px-3.5 py-2 text-left transition-colors ${active ? 'border-accent bg-accent/15' : 'border-dark-600 bg-dark-800/60 hover:border-dark-400'}`}>
                  <span className={`block text-sm font-medium ${active ? 'text-white' : 'text-slate-300'}`}>
                    {dayLabel(d.date)} {d.panelsLocked && <span title="Panels locked">🔒</span>}{d.status === 'CLOSED' && <span className="ml-1 text-[10px] uppercase text-slate-400">closed</span>}
                  </span>
                  <span className="block text-xs text-slate-400 tabular-nums">{c.placed}/{c.total} filled</span>
                </button>
              );
            })}
          </div>

          {day && (
            <>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-slate-400">
                  Drag a candidate onto another slot to move them; drop on a filled slot to swap.
                </p>
                <button type="button" disabled={busy || day.status === 'CLOSED'} onClick={() => toggleLock(day)}
                  className={`px-3 py-1.5 rounded-lg border text-sm transition-colors disabled:opacity-40 ${day.panelsLocked ? 'border-amber-400/40 text-amber-200 hover:bg-amber-400/10' : 'border-dark-500 text-slate-200 hover:border-accent/60'}`}>
                  {day.panelsLocked ? '🔒 Panels locked · unlock' : 'Lock panels for this day'}
                </button>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {day.blocks.map((b) => (
                  <div key={b.block} className="rounded-xl border border-dark-600 bg-dark-800/60 p-3">
                    <h2 className="text-sm font-semibold text-white px-1 mb-2">
                      {b.block} <span className="text-slate-400 font-normal">{b.slots[0]?.start}–{b.slots[b.slots.length - 1]?.end}</span>
                    </h2>
                    <div className="space-y-1.5">
                      {b.slots.map((s) => (
                        <SlotRow key={s.id} slot={s} closed={day.status === 'CLOSED'} dragging={dragging} busy={busy}
                          onDragStart={(sid) => setDragging(sid)} onDragEnd={() => setDragging(null)}
                          onDrop={(sid) => { setDragging(null); moveTo(sid, s.id); }}
                          onMoveClick={(c) => setMoving(c)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {moving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setMoving(null)}>
          <div className="w-full max-w-md rounded-2xl border border-dark-500 bg-[#0c1220] p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-white">Move {moving.name}</h3>
            <p className="text-xs text-slate-400 mt-1 mb-3">Free interview slots with a panel, on any open day.</p>
            {freeSlots.length === 0 ? <p className="text-sm text-slate-400">There are no free slots.</p> : (
              <select size={10} className="w-full rounded-lg bg-dark-700 border border-dark-500 text-sm text-white p-1"
                onChange={(e) => e.target.value && moveTo(moving.sessionId, e.target.value)}>
                {freeSlots.map((s) => (
                  <option key={s.id} value={s.id}>{dayLabel(s.date)} · {s.start} · {s.panel.map((p) => p.name).join(', ')}</option>
                ))}
              </select>
            )}
            <button type="button" onClick={() => setMoving(null)} className="mt-4 text-sm text-slate-400 hover:text-white">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SlotRow({ slot, closed, dragging, busy, onDragStart, onDragEnd, onDrop, onMoveClick }: {
  slot: Slot; closed: boolean; dragging: string | null; busy: boolean;
  onDragStart: (sessionId: string) => void; onDragEnd: () => void; onDrop: (sessionId: string) => void; onMoveClick: (c: Candidate) => void;
}) {
  const [over, setOver] = useState(false);
  const time = <span className="w-[5.5rem] shrink-0 text-xs tabular-nums text-slate-400">{slot.start}–{slot.end}</span>;

  if (slot.kind !== 'INTERVIEW') {
    return (
      <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 bg-white/[0.02]">
        {time}
        <span className="text-xs uppercase tracking-wide text-slate-500">{slot.kind === 'BREAK' ? 'Break' : 'Calibration'}</span>
      </div>
    );
  }

  const noPanel = slot.panel.length === 0;
  const c = slot.candidate;
  const canDrop = !noPanel && !closed && !!dragging && dragging !== c?.sessionId && !c?.started;
  const draggable = !!c && !c.started && !closed && !busy;

  return (
    <div
      onDragOver={(e) => { if (canDrop) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const sid = e.dataTransfer.getData('text/plain'); if (sid && canDrop) onDrop(sid); }}
      className={`flex items-start gap-3 rounded-lg border px-2 py-1.5 transition-colors ${
        noPanel ? 'border-transparent bg-white/[0.01] opacity-50'
          : over ? 'border-accent bg-accent/10'
          : canDrop ? 'border-dashed border-accent/40'
          : 'border-dark-600'}`}>
      <span className="pt-1">{time}</span>
      <div className="min-w-0 flex-1">
        {noPanel ? (
          <span className="text-xs text-slate-500">No panel</span>
        ) : c ? (
          <div className="flex items-center gap-2">
            <span draggable={draggable}
              onDragStart={(e) => { e.dataTransfer.setData('text/plain', c.sessionId); e.dataTransfer.effectAllowed = 'move'; onDragStart(c.sessionId); }}
              onDragEnd={onDragEnd}
              title={c.started ? 'Interview started: can no longer be moved' : 'Drag to move or swap'}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-sm ${c.started ? 'bg-white/[0.05] text-slate-300' : 'bg-accent/15 text-white cursor-grab active:cursor-grabbing'}`}>
              {c.started && <span aria-hidden>🔒</span>}{c.name}
            </span>
            {draggable && (
              <button type="button" onClick={() => onMoveClick(c)} className="text-[11px] text-slate-400 hover:text-white">Move to…</button>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-500">{canDrop ? 'Drop here' : 'Open'}</span>
        )}
        {!noPanel && <p className="mt-0.5 text-[11px] text-slate-500 truncate">{slot.panel.map((p) => p.name).join(' · ')}</p>}
      </div>
    </div>
  );
}

function CandidateUpload({ api, onDone }: {
  api: (path: string, init?: RequestInit) => Promise<{ res: Response; body: any }>;
  onDone: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CandidatePreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const send = async (path: 'preview' | 'commit', f: File) => {
    const form = new FormData();
    form.append('file', f);
    return api(`/candidates/${path}`, { method: 'POST', body: form });
  };

  const check = async (f: File) => {
    setFile(f); setPreview(null); setFailure(null);
    if (!f.name.toLowerCase().endsWith('.xlsx')) { setFailure('Choose the candidates workbook (.xlsx).'); return; }
    setWorking(true);
    const { res, body } = await send('preview', f);
    setWorking(false);
    if (!res.ok) setFailure(messageOf(body, `The check failed (${res.status}).`));
    else setPreview(body);
  };

  const commit = async () => {
    if (!file || !preview?.ok) return;
    setWorking(true);
    const { res, body } = await send('commit', file);
    setWorking(false);
    if (!res.ok) {
      setFailure(messageOf(body, `The upload failed (${res.status}).`));
      if (Array.isArray(body?.errors)) setPreview((p) => (p ? { ...p, ok: false, errors: body.errors } : p));
      return;
    }
    const c = body.counts;
    onDone(`Candidates uploaded: ${c.add} added, ${c.move} moved${c.unchanged ? `, ${c.unchanged} unchanged` : ''}.`);
  };

  return (
    <div className="mb-5 rounded-xl border border-dark-600 bg-dark-800/80 p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white">Upload candidates</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Name, Date and Time (the start of an interview slot). Each upload adds the candidates in it and moves any whose slot changed; everyone else stays put.
        </p>
      </div>
      <div onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) check(f); }}
        className="rounded-xl border-2 border-dashed border-dark-500 hover:border-dark-400 p-6 text-center cursor-pointer">
        <input ref={fileRef} type="file" accept=".xlsx" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); e.target.value = ''; }} />
        <p className="text-sm text-slate-300">{file ? file.name : 'Drop the candidates file here, or click to choose it'}</p>
        {working && <p className="text-xs text-slate-400 mt-1">Working…</p>}
      </div>
      {failure && <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-red-300">{failure}</div>}
      {preview && (
        <>
          <p className={`text-sm ${preview.ok ? 'text-emerald-200' : 'text-red-200'}`}>
            {preview.ok
              ? `Ready: ${preview.counts.add} to add, ${preview.counts.move} to move, ${preview.counts.unchanged} unchanged.`
              : `${preview.errors.length} problem${preview.errors.length === 1 ? '' : 's'} to fix before this can be uploaded.`}
          </p>
          <IssueList title="Problems to fix" tone="error" issues={preview.errors} />
          <IssueList title="Moves" tone="warning" issues={preview.warnings} />
          <button type="button" onClick={commit} disabled={!preview.ok || working}
            className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium">
            Place candidates
          </button>
        </>
      )}
    </div>
  );
}
