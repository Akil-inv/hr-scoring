'use client';

import { useRef, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useCurrentEvent, useEventStore } from '@/lib/event-store';
import { IssueList, dayLabel, messageOf } from '@/components/upload-common';

/**
 * Set up an interview event from one Excel workbook: day template, judges and
 * their availability. Choosing a file checks it and shows the schedule it
 * would build, every problem by sheet and row. Nothing is saved until the
 * admin confirms; then the Schedule page opens, ready for candidates.
 */

import type { Issue } from '@/components/upload-common';
type DayBlock = { block: string; interviews: number; withPanel: number; judges: string[] };
type Preview = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  replacing: { eventId: string; name: string } | null;
  summary: {
    eventName: string | null;
    timezone: string | null;
    minPanel: number | null;
    judges: number;
    days: number;
    interviews: number;
    interviewsWithPanel: number;
    blocks: { block: string; start: string; end: string; interviews: number }[];
    schedule: { date: string; blocks: DayBlock[] }[];
    rubric: string;
    supportQuestion: string | null;
  };
};

const TEMPLATE_URL = '/templates/event-setup-template.xlsx';

export default function UploadSetupPage() {
  const token = useAuthStore((s) => s.token);
  const current = useCurrentEvent();
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [checking, setChecking] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const send = async (path: 'preview' | 'commit', f: File, replaceIt: boolean) => {
    const form = new FormData();
    form.append('file', f);
    if (replaceIt && current?.id) form.append('eventId', current.id);
    const res = await fetch(`/api/setup-upload/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  };

  const check = async (f: File, replaceIt = replace) => {
    setFile(f);
    setPreview(null);
    setFailure(null);
    setDone(null);
    if (!f.name.toLowerCase().endsWith('.xlsx')) {
      setFailure('Choose an Excel workbook (.xlsx). Start from the template if you are unsure of the format.');
      return;
    }
    setChecking(true);
    try {
      const { res, body } = await send('preview', f, replaceIt);
      if (!res.ok) setFailure(messageOf(body, `The check failed (${res.status}).`));
      else setPreview(body);
    } catch (e: any) {
      setFailure(e?.message ?? 'Could not reach the server.');
    }
    setChecking(false);
  };

  const commit = async () => {
    if (!file || !preview?.ok) return;
    setCommitting(true);
    setFailure(null);
    try {
      const { res, body } = await send('commit', file, replace);
      if (!res.ok) {
        setFailure(messageOf(body, `The upload failed (${res.status}).`));
        if (Array.isArray(body?.errors)) setPreview((p) => (p ? { ...p, ok: false, errors: body.errors } : p));
      } else {
        setDone(`${preview.summary.eventName} is set up. Opening the schedule…`);
        // Select the new event first, so the schedule opens on it. A full load
        // makes the event list refetch and include it.
        useEventStore.setState({ eventId: body.eventId });
        setTimeout(() => window.location.assign('/dashboard/schedule'), 900);
      }
    } catch (e: any) {
      setFailure(e?.message ?? 'Could not reach the server.');
    }
    setCommitting(false);
  };

  const s = preview?.summary;

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Upload setup</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Set up the interviews from one workbook: day template, judges and their availability.
            The schedule is built from it. Nothing is saved until you confirm.
          </p>
        </div>
        <a href={TEMPLATE_URL} download
          className="shrink-0 px-4 py-2 rounded-lg border border-dark-500 text-sm text-white hover:border-accent/60 hover:bg-accent/5 transition-colors">
          Download template
        </a>
      </div>

      {current && (
        <label className="mb-4 flex items-start gap-3 rounded-xl border border-dark-600 bg-dark-800/60 px-4 py-3 cursor-pointer">
          <input type="checkbox" checked={replace} onChange={(e) => { setReplace(e.target.checked); if (file) check(file, e.target.checked); }}
            className="mt-1 accent-[#7c3aed]" />
          <span className="text-sm">
            <span className="text-white">Replace the setup of <strong>{current.name}</strong></span>
            <span className="block text-xs text-slate-400 mt-0.5">
              Only before any candidate is placed. Leave unticked to create a new event.
            </span>
          </span>
        </label>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) check(f); }}
        onClick={() => fileRef.current?.click()}
        className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all ${dragOver ? 'border-accent bg-accent/5' : 'border-dark-500 hover:border-dark-400'}`}>
        <input ref={fileRef} type="file" accept=".xlsx" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); e.target.value = ''; }} />
        {file ? (
          <>
            <p className="text-sm text-white font-medium">{file.name}</p>
            <p className="text-xs text-slate-400 mt-1">{checking ? 'Checking…' : 'Click or drop another file to check it instead.'}</p>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-300">Drop the setup workbook here, or click to choose it</p>
            <p className="text-xs text-slate-500 mt-1">.xlsx, up to 5 MB</p>
          </>
        )}
      </div>

      {failure && <div className="mt-4 rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-red-300">{failure}</div>}

      {preview && s && (
        <div className="mt-6 space-y-6">
          <div className={`rounded-xl border px-4 py-3 text-sm ${preview.ok ? 'border-success/30 bg-success/10 text-emerald-200' : 'border-error/30 bg-error/10 text-red-200'}`}>
            {preview.ok
              ? <>Ready to {preview.replacing ? <>replace the setup of <strong>{preview.replacing.name}</strong></> : <>set up <strong>{s.eventName}</strong></>}
                  {preview.warnings.length > 0 && <> · {preview.warnings.length} warning{preview.warnings.length === 1 ? '' : 's'} to look over</>}.</>
              : <>{preview.errors.length} problem{preview.errors.length === 1 ? '' : 's'} to fix in the workbook before it can be uploaded.</>}
          </div>

          {(s.judges > 0 || s.days > 0) && <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ['Judging days', s.days],
              ['Judges', s.judges],
              ['Interview slots', s.interviews],
              ['With a panel', s.interviewsWithPanel],
            ].map(([label, n]) => (
              <div key={label as string} className="rounded-xl border border-dark-600 bg-dark-800/60 px-4 py-3">
                <p className="text-2xl font-semibold text-white tabular-nums">{n}</p>
                <p className="text-xs text-slate-400">{label}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-4 text-sm">
            <p className="text-slate-300">
              {[
                ...s.blocks.map((b) => `${b.block} ${b.start}–${b.end} (${b.interviews} interviews)`),
                s.minPanel ? `panels of at least ${s.minPanel}` : null,
                s.timezone,
                s.rubric,
                s.supportQuestion ? `judges answer "${s.supportQuestion}" Yes / No` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          </>}

          {s.schedule.length > 0 && (
            <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-4">
              <h2 className="text-sm font-semibold text-white mb-3">Schedule this builds</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-400 text-left">
                    <th className="font-medium pb-2 w-32">Day</th>
                    {s.blocks.map((b) => <th key={b.block} className="font-medium pb-2">{b.block}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {s.schedule.map((d) => (
                    <tr key={d.date} className="border-t border-dark-600 align-top">
                      <td className="py-2 text-slate-200 whitespace-nowrap">{dayLabel(d.date)}</td>
                      {s.blocks.map((b) => {
                        const x = d.blocks.find((y) => y.block === b.block);
                        if (!x) return <td key={b.block} className="py-2 text-slate-600">—</td>;
                        return (
                          <td key={b.block} className="py-2 pr-4">
                            <span className={x.withPanel < x.interviews ? 'text-amber-300' : 'text-slate-200'}>
                              {x.withPanel}/{x.interviews} with panel
                            </span>
                            <span className="block text-xs text-slate-400">{x.judges.join(', ') || 'nobody'}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <IssueList title="Problems to fix" tone="error" issues={preview.errors} />
          <IssueList title="Warnings" tone="warning" issues={preview.warnings} />

          <div className="flex items-center gap-4">
            <button type="button" onClick={commit} disabled={!preview.ok || committing || !!done}
              className="px-5 py-2.5 rounded-lg bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium shadow-lg shadow-accent/20">
              {committing ? 'Building the schedule…' : preview.replacing ? 'Replace setup and open schedule' : 'Set up and open schedule'}
            </button>
            {done && <span className="text-sm text-emerald-300">{done}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
