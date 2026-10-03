'use client';

import { useRef, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useCurrentEvent, useEventStore } from '@/lib/event-store';

/**
 * Set up an event from one Excel workbook.
 *
 * Choosing a file checks it straight away and shows what it would create,
 * every problem by sheet and row. Nothing is saved until the admin confirms;
 * then the event is built in one go and the Command Centre opens on it.
 */

type Issue = { sheet: string; row: number | null; message: string };
type Day = { date: string; sessions: number; judges: number; teams: number };
type Preview = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  replacing: { eventId: string; name: string } | null;
  summary: {
    eventName: string | null;
    timezone: string | null;
    rooms: number;
    tracks: string[];
    teams: number;
    judges: number;
    sessions: number;
    days: Day[];
    rubric: string;
  };
};

const TEMPLATE_URL = '/templates/event-setup-template.xlsx';

function dayLabel(iso: string) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

/** Nest sends message as a string, an array, or (for our 400s) alongside an errors list. */
function messageOf(body: any, fallback: string): string {
  const m = body?.message;
  if (Array.isArray(m)) return m.join(' ');
  if (typeof m === 'string') return m;
  return fallback;
}

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
    const res = await fetch(`/api/setup-upload/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
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
        setDone(`${preview.summary.eventName} is ready. Opening the Command Centre…`);
        // Select the new event before navigating, so the Command Centre opens
        // on it rather than on whichever event was selected before. A full
        // load makes the event list refetch and include it.
        useEventStore.setState({ eventId: body.eventId });
        setTimeout(() => window.location.assign('/dashboard/operations'), 900);
      }
    } catch (e: any) {
      setFailure(e?.message ?? 'Could not reach the server.');
    }
    setCommitting(false);
  };

  const toggleReplace = (v: boolean) => {
    setReplace(v);
    if (file) check(file, v);
  };

  const s = preview?.summary;

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Upload setup</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Set up a whole event from one Excel workbook: rooms, teams, judges, rubric and schedule.
            Nothing is saved until you confirm.
          </p>
        </div>
        <a href={TEMPLATE_URL} download
          className="shrink-0 px-4 py-2 rounded-lg border border-dark-500 text-sm text-white hover:border-accent/60 hover:bg-accent/5 transition-colors">
          Download template
        </a>
      </div>

      {current && (
        <label className="mb-4 flex items-start gap-3 rounded-xl border border-dark-600 bg-dark-800/60 px-4 py-3 cursor-pointer">
          <input type="checkbox" checked={replace} onChange={(e) => toggleReplace(e.target.checked)}
            className="mt-1 accent-[#7c3aed]" />
          <span className="text-sm">
            <span className="text-white">Replace the setup of <strong>{current.name}</strong></span>
            <span className="block text-xs text-slate-400 mt-0.5">
              Only for events created by upload, and only before any scoring. Leave unticked to create a new event.
            </span>
          </span>
        </label>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) check(f); }}
        onClick={() => fileRef.current?.click()}
        className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-all ${
          dragOver ? 'border-accent bg-accent/5' : 'border-dark-500 hover:border-dark-400'
        }`}>
        <input ref={fileRef} type="file" accept=".xlsx" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) check(f); e.target.value = ''; }} />
        {file ? (
          <>
            <p className="text-sm text-white font-medium">{file.name}</p>
            <p className="text-xs text-slate-400 mt-1">
              {checking ? 'Checking…' : 'Click or drop another file to check it instead.'}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-300">Drop the setup workbook here, or click to choose it</p>
            <p className="text-xs text-slate-500 mt-1">.xlsx, up to 5 MB</p>
          </>
        )}
      </div>

      {failure && (
        <div className="mt-4 rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-red-300">{failure}</div>
      )}

      {preview && s && (
        <div className="mt-6 space-y-6">
          <div className={`rounded-xl border px-4 py-3 text-sm ${
            preview.ok ? 'border-success/30 bg-success/10 text-emerald-200' : 'border-error/30 bg-error/10 text-red-200'
          }`}>
            {preview.ok
              ? <>Ready to {preview.replacing ? <>replace the setup of <strong>{preview.replacing.name}</strong></> : <>create <strong>{s.eventName}</strong></>}
                  {preview.warnings.length > 0 && <> · {preview.warnings.length} warning{preview.warnings.length === 1 ? '' : 's'} to look over</>}.</>
              : <>{preview.errors.length} problem{preview.errors.length === 1 ? '' : 's'} to fix in the workbook before it can be uploaded.</>}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {[
              ['Teams', s.teams],
              ['Judges', s.judges],
              ['Rooms', s.rooms],
              ['Sessions', s.sessions],
              ['Judging days', s.days.length],
            ].map(([label, n]) => (
              <div key={label as string} className="rounded-xl border border-dark-600 bg-dark-800/60 px-4 py-3">
                <p className="text-2xl font-semibold text-white tabular-nums">{n}</p>
                <p className="text-xs text-slate-400">{label}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-4">
              <h2 className="text-sm font-semibold text-white mb-3">Judging days</h2>
              {s.days.length === 0 ? <p className="text-xs text-slate-500">No sessions could be read yet.</p> : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-400 text-left">
                      <th className="font-medium pb-2">Day</th>
                      <th className="font-medium pb-2 text-right">Sessions</th>
                      <th className="font-medium pb-2 text-right">Judges</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.days.map((d) => (
                      <tr key={d.date} className="border-t border-dark-600">
                        <td className="py-1.5 text-slate-200">{dayLabel(d.date)}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-200">{d.sessions}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-200">{d.judges}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-4 text-sm space-y-2">
              <h2 className="text-sm font-semibold text-white mb-1">Event</h2>
              <p><span className="text-slate-400">Name </span><span className="text-slate-200">{s.eventName ?? '—'}</span></p>
              <p><span className="text-slate-400">Timezone </span><span className="text-slate-200">{s.timezone ?? '—'}</span></p>
              <p><span className="text-slate-400">Rubric </span><span className="text-slate-200">{s.rubric}</span></p>
              <p><span className="text-slate-400">Tracks </span><span className="text-slate-200">{s.tracks.length ? s.tracks.join(', ') : 'none'}</span></p>
            </div>
          </div>

          <IssueList title="Problems to fix" tone="error" issues={preview.errors} />
          <IssueList title="Warnings" tone="warning" issues={preview.warnings} />

          <div className="flex items-center gap-4">
            <button type="button" onClick={commit} disabled={!preview.ok || committing || !!done}
              className="px-5 py-2.5 rounded-lg bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium shadow-lg shadow-accent/20">
              {committing ? 'Building the event…' : preview.replacing ? 'Replace setup and open Command Centre' : 'Create event and open Command Centre'}
            </button>
            {done && <span className="text-sm text-emerald-300">{done}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function IssueList({ title, tone, issues }: { title: string; tone: 'error' | 'warning'; issues: Issue[] }) {
  if (issues.length === 0) return null;
  const dot = tone === 'error' ? 'bg-error' : 'bg-warning';
  return (
    <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-4">
      <h2 className="text-sm font-semibold text-white mb-3">{title} <span className="text-slate-400 font-normal">({issues.length})</span></h2>
      <ul className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
        {issues.map((i, n) => (
          <li key={n} className="flex gap-3 text-sm">
            <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="w-36 shrink-0 whitespace-nowrap text-xs text-slate-400 pt-0.5 font-mono">{i.sheet}{i.row ? ` · row ${i.row}` : ''}</span>
            <span className="text-slate-200">{i.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
