'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { dayLabel, messageOf } from '@/components/upload-common';

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
  const message = (r: Row, d: Day) =>
    `Hi ${r.name}, here is your judging link for ${eventName} on ${dayLabel(d.date)}` +
    `${r.interviews ? ` (${r.interviews} interview${r.interviews === 1 ? '' : 's'})` : ''}: ${origin}${r.link}\n` +
    'It works for that day only. Please do not forward it.';

  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500); }
    catch { window.prompt('Copy this:', text); }
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
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400">
                    <th className="px-4 py-2 font-medium">Judge</th>
                    <th className="px-2 py-2 font-medium">Interviews</th>
                    <th className="px-2 py-2 font-medium">Last opened</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {day.links.map((r) => (
                    <tr key={r.judgeId} className="border-t border-dark-600 align-top">
                      <td className="px-4 py-2">
                        <span className="block text-white">{r.name}</span>
                        <span className="block text-xs text-slate-500">{r.email}{r.phone ? ` · ${r.phone}` : ''}</span>
                      </td>
                      <td className="px-2 py-2 tabular-nums text-slate-300">{r.interviews}</td>
                      <td className="px-2 py-2 text-xs text-slate-400">
                        {r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString('en-SG') : 'Not yet'}
                        {r.reissued > 0 && <span className="block text-amber-300">Reissued {r.reissued}×</span>}
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {r.link && !day.closed ? (
                          <span className="inline-flex gap-2">
                            <button type="button" onClick={() => copy(`l-${r.judgeId}`, `${origin}${r.link}`)}
                              className="rounded-lg border border-dark-500 px-2.5 py-1 text-xs text-slate-200 hover:border-accent/60">
                              {copied === `l-${r.judgeId}` ? '✓ Copied' : 'Copy link'}
                            </button>
                            <button type="button" onClick={() => copy(`m-${r.judgeId}`, message(r, day))}
                              className="rounded-lg border border-dark-500 px-2.5 py-1 text-xs text-slate-200 hover:border-accent/60">
                              {copied === `m-${r.judgeId}` ? '✓ Copied' : 'Copy message'}
                            </button>
                            <a href={r.link} target="_blank" rel="noreferrer" className="rounded-lg border border-dark-500 px-2.5 py-1 text-xs text-slate-200 hover:border-accent/60">Open</a>
                            <button type="button" onClick={() => reissue(r)} disabled={busy === r.judgeId}
                              className="rounded-lg border border-dark-500 px-2.5 py-1 text-xs text-amber-200 hover:border-amber-400/60 disabled:opacity-40">
                              {busy === r.judgeId ? '…' : 'Reissue'}
                            </button>
                          </span>
                        ) : <span className="text-xs text-slate-500">Closed</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
