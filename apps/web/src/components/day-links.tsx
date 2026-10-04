'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { dayLabel, messageOf } from '@/components/upload-common';
import { copyText } from '@/lib/copy';

/** The message sent with each link. Placeholders are filled in per judge. */
const DEFAULT_TEMPLATE =
  'Hi {name},\n\n' +
  'Thank you for being on the interview panel for {event} on {day}. You have {interviews} scheduled.\n\n' +
  'Your judging link: {link}\n\n' +
  'It works for {day} only and stops when the day is closed. Please do not forward it.';
const PLACEHOLDERS = ['{name}', '{day}', '{interviews}', '{event}', '{link}'];

function CopyIcon({ done }: { done: boolean }) {
  return done ? (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 10.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ) : (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="7" y="7" width="9" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 13V4.5A1.5 1.5 0 015.5 3H13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

type Row = {
  linkId: string | null; judgeId: string; name: string; email: string; phone: string | null;
  interviews: number; link: string | null; lastUsedAt: string | null; reissued: number;
};
type Day = { date: string; closed: boolean; closedAt: string | null; links: Row[] };

/**
 * Judge links for an interview event: one per judge per day. Each opens only
 * that day's interviews and stops working when the day is closed. Reissue
 * cancels a link (forwarded, lost) and makes a new one.
 */
export default function DayLinks({ eventId, eventName, token }: { eventId: string; eventName: string; token: string | null }) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const storeKey = `judge-link-message:${eventId}`;
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    try { const t = localStorage.getItem(storeKey); if (t) setTemplate(t); } catch { /* not available */ }
  }, [storeKey]);
  const saveTemplate = (t: string) => {
    setTemplate(t);
    try { localStorage.setItem(storeKey, t); } catch { /* not available */ }
  };

  const load = useCallback(async () => {
    const res = await fetch(`/api/judge-links/${eventId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(messageOf(body, `Could not load the links (${res.status}).`)); return; }
    setError(null);
    setDays(body.days);
    const today = new Date().toISOString().slice(0, 10);
    setDate((d) => d ?? body.days.find((x: Day) => !x.closed && x.date >= today)?.date ?? body.days.find((x: Day) => !x.closed)?.date ?? body.days[0]?.date ?? null);
  }, [eventId, token]);
  useEffect(() => { load(); }, [load]);

  const day = useMemo(() => days?.find((d) => d.date === date) ?? null, [days, date]);
  const message = (r: Row, d: Day) => template
    .split('{name}').join(r.name)
    .split('{day}').join(dayLabel(d.date))
    .split('{interviews}').join(`${r.interviews} interview${r.interviews === 1 ? '' : 's'}`)
    .split('{event}').join(eventName)
    .split('{link}').join(`${origin}${r.link}`);

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) { setCopied(key); setTimeout(() => setCopied(null), 1500); }
    else setError('Could not copy. Select the text and copy it by hand.');
  };
  const reissue = async (r: Row) => {
    if (!r.linkId) return;
    if (!window.confirm(`Reissue ${r.name}'s link for ${dayLabel(day!.date)}? The current link stops working straight away; send them the new one.`)) return;
    setBusy(r.judgeId);
    const res = await fetch(`/api/judge-links/${eventId}/${r.linkId}/reissue`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(messageOf(body, 'Could not reissue the link.')); return; }
    await load();
  };

  if (error) return <div className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-red-300">{error}</div>;
  if (!days) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-bold text-white">Judge links</h1>
        <p className="mt-0.5 text-sm text-slate-400">
          One link per judge per day. A link opens only that day&apos;s interviews and stops working when you close the day.
          If a link is forwarded or lost, reissue it: the old one stops at once.
        </p>
      </div>
      {days.length === 0 ? <p className="text-sm text-slate-400">No judge is on a panel yet.</p> : (
        <>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-2">
            {days.map((d) => (
              <button key={d.date} type="button" onClick={() => setDate(d.date)}
                className={`shrink-0 rounded-xl border px-3.5 py-2 text-left transition-colors ${d.date === date ? 'border-accent bg-accent/15' : 'border-dark-600 bg-dark-800/60 hover:border-dark-400'}`}>
                <span className={`block text-sm font-medium ${d.date === date ? 'text-white' : 'text-slate-300'}`}>{d.closed ? '🔒 ' : ''}{dayLabel(d.date)}</span>
                <span className="block text-xs text-slate-400">{d.closed ? 'Closed' : `${d.links.length} judge${d.links.length === 1 ? '' : 's'}`}</span>
              </button>
            ))}
          </div>
          <div className="mb-4 rounded-xl border border-dark-600 bg-dark-800/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-white">Message sent with each link</p>
                <p className="text-xs text-slate-400">Placeholders filled in for each judge: {PLACEHOLDERS.join('  ')}</p>
              </div>
              <div className="flex gap-2">
                {editing && template !== DEFAULT_TEMPLATE && (
                  <button type="button" onClick={() => saveTemplate(DEFAULT_TEMPLATE)}
                    className="rounded-lg border border-dark-500 px-3 py-1.5 text-xs text-slate-300 hover:border-accent/60">Reset to default</button>
                )}
                <button type="button" onClick={() => setEditing((v) => !v)}
                  className="rounded-lg border border-dark-500 px-3 py-1.5 text-xs text-slate-200 hover:border-accent/60">{editing ? 'Done' : 'Edit message'}</button>
              </div>
            </div>
            {editing && (
              <>
                <textarea id="link-message" value={template} onChange={(e) => saveTemplate(e.target.value)} rows={6}
                  className="mt-3 w-full rounded-lg border border-dark-500 bg-dark-700 px-3 py-2 text-sm leading-relaxed text-white outline-none focus:border-accent/60" />
                {!template.includes('{link}') && <p className="mt-1 text-xs text-amber-300">The message has no {'{link}'}, so judges won&apos;t get their link.</p>}
                <p className="mt-1 text-xs text-slate-500">Saved in this browser for this event.</p>
              </>
            )}
          </div>

          {day && (
            <div className="rounded-xl border border-dark-600 bg-dark-800/60">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dark-600 px-4 py-3">
                <p className="text-sm text-slate-300">
                  {day.closed ? `${dayLabel(day.date)} is closed. Its links no longer open.` : `Links for ${dayLabel(day.date)}. Send each judge their own.`}
                </p>
                {!day.closed && (
                  <button type="button" onClick={() => copy('all', day.links.filter((r) => r.link).map((r) => message(r, day)).join('\n\n'))}
                    className="rounded-lg border border-dark-500 px-3 py-1.5 text-sm text-slate-200 hover:border-accent/60">
                    {copied === 'all' ? '✓ Copied' : 'Copy all messages'}
                  </button>
                )}
              </div>
              <ul className="divide-y divide-dark-600">
                {day.links.map((r) => {
                  const text = r.link ? message(r, day) : '';
                  return (
                    <li key={r.judgeId} className="grid gap-3 px-4 py-3 md:grid-cols-[220px_minmax(0,1fr)]">
                      <div className="min-w-0">
                        <p className="text-white">{r.name}</p>
                        <p className="truncate text-xs text-slate-500">{r.email}{r.phone ? ` · ${r.phone}` : ''}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {r.interviews} interview{r.interviews === 1 ? '' : 's'} · {r.lastUsedAt ? `opened ${new Date(r.lastUsedAt).toLocaleString('en-SG')}` : 'not opened yet'}
                        </p>
                        {r.reissued > 0 && <p className="text-xs text-amber-300">Reissued {r.reissued}×</p>}
                        {r.link && !day.closed && (
                          <div className="mt-2 flex gap-2">
                            <a href={r.link} target="_blank" rel="noreferrer" className="rounded-lg border border-dark-500 px-2.5 py-1 text-xs text-slate-200 hover:border-accent/60">Open</a>
                            <button type="button" onClick={() => reissue(r)} disabled={busy === r.judgeId}
                              className="rounded-lg border border-dark-500 px-2.5 py-1 text-xs text-amber-200 hover:border-amber-400/60 disabled:opacity-40">
                              {busy === r.judgeId ? '…' : 'Reissue'}
                            </button>
                          </div>
                        )}
                      </div>
                      {r.link && !day.closed ? (
                        <div className="min-w-0 space-y-2">
                          <div className="relative rounded-lg border border-dark-500 bg-dark-700/70 p-3 pr-11">
                            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200">{text}</p>
                            <button type="button" onClick={() => copy(`m-${r.judgeId}`, text)} title="Copy message" aria-label={`Copy message for ${r.name}`}
                              className={`absolute right-2 top-2 rounded-md p-1.5 ${copied === `m-${r.judgeId}` ? 'text-emerald-300' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
                              <CopyIcon done={copied === `m-${r.judgeId}`} />
                            </button>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-400">
                            <span className="truncate font-mono">{origin}{r.link}</span>
                            <button type="button" onClick={() => copy(`l-${r.judgeId}`, `${origin}${r.link}`)} title="Copy link only" aria-label={`Copy link for ${r.name}`}
                              className={`shrink-0 rounded-md p-1 ${copied === `l-${r.judgeId}` ? 'text-emerald-300' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}>
                              <CopyIcon done={copied === `l-${r.judgeId}`} />
                            </button>
                          </div>
                        </div>
                      ) : <p className="self-center text-xs text-slate-500">Closed</p>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
