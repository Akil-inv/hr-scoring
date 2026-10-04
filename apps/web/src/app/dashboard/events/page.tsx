'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useEventId } from '@/lib/event-store';
import { ControlledEvent, DIRECTORY, dateRange, day, gql, retentionText, roleLabel } from '@/lib/event-control';
import { btn, Chip, ErrorNote, StageBadge } from '@/components/event-control-ui';

type Filter = 'all' | 'mine' | 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED' | 'DONE';

/**
 * Event Control: every event and who manages it.
 *
 * Everyone on staff sees every event's name, status, dates and admins, so they
 * know whom to ask. What's inside an event is only for the people on it.
 */
export default function EventControlPage() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const currentId = useEventId();
  const [events, setEvents] = useState<ControlledEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    gql<{ eventDirectory: ControlledEvent[] }>(token, DIRECTORY)
      .then((d) => setEvents(d.eventDirectory))
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const canCreate = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';
  const due = (events ?? []).filter((e) => e.due && e.myRole === 'ADMIN');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, mine: 0, DRAFT: 0, ACTIVE: 0, CLOSED: 0, ARCHIVED: 0, DONE: 0 };
    for (const e of events ?? []) { c.all++; if (e.onEvent) c.mine++; c[e.stage] = (c[e.stage] ?? 0) + 1; }
    return c;
  }, [events]);

  const shown = (events ?? []).filter((e) => {
    if (filter === 'mine' && !e.onEvent) return false;
    if (filter !== 'all' && filter !== 'mine' && e.stage !== filter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return e.name.toLowerCase().includes(q) || e.admins.some((a) => a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q));
  });

  const tabs: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' }, { id: 'mine', label: 'My events' }, { id: 'ACTIVE', label: 'Active' },
    { id: 'DRAFT', label: 'Draft' }, { id: 'CLOSED', label: 'Closed' }, { id: 'ARCHIVED', label: 'Archived' }, { id: 'DONE', label: 'Done' },
  ];

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-white">Event Control</h1>
          <p className="mt-1 text-sm text-[#8694a8]">Every event and who manages it. You can open the events you&apos;re on; for the others, ask one of their admins.</p>
        </div>
        {canCreate && (
          <Link href="/dashboard/events/new" className={btn.primary}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            New event
          </Link>
        )}
      </div>

      <ErrorNote message={error} />

      {due.map((e) => (
        <div key={e.id} className="flex flex-wrap items-center gap-4 rounded-2xl border border-red-500/25 bg-red-500/[0.07] px-5 py-4">
          <div className="min-w-[260px] flex-1 text-sm leading-relaxed text-[#e8edf5]">
            <strong className="font-semibold">{e.name}</strong> reached the end of its retention period on {day(e.retainUntil)}. An admin can extend it, or mark
            the event done: its candidate data is then removed and only the event&apos;s record and audit log remain. Nothing happens until someone decides.
          </div>
          <Link href={`/dashboard/events/${e.id}`} className={btn.danger}>Extend or mark done</Link>
        </div>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter events">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setFilter(t.id)} aria-pressed={filter === t.id}
              className={`rounded-[9px] border px-3.5 py-2 text-[13px] font-medium transition ${filter === t.id ? 'border-white/[0.08] bg-[#162035] text-white' : 'border-transparent text-[#8694a8] hover:text-white'}`}>
              {t.label} · {counts[t.id] ?? 0}
            </button>
          ))}
        </div>
        <label className="flex min-h-[40px] min-w-[240px] items-center gap-2 rounded-[10px] border border-white/[0.08] bg-[#0c1220] px-3">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8694a8" strokeWidth="2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events or admins" aria-label="Search events or admins"
            className="w-full bg-transparent text-sm text-white outline-none placeholder:text-[#6b7a90]" />
        </label>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/[0.07] bg-[#0c1220]">
        <div className="min-w-[1040px]">
          <div className="grid grid-cols-[2.1fr_1.1fr_1.3fr_1.7fr_1fr_1.4fr_132px] gap-4 border-b border-white/[0.07] px-5 py-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8694a8]">
            <div>Event</div><div>Dates</div><div>Progress</div><div>Managed by</div><div>Your access</div><div>Retention</div><div />
          </div>
          {events === null && !error && <div className="px-5 py-10 text-center text-sm text-[#8694a8]">Loading events…</div>}
          {events !== null && shown.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-[#8694a8]">{events.length === 0 ? 'No events yet.' : 'No events match.'}</div>
          )}
          {shown.map((e) => {
            const current = e.id === currentId;
            const p = e.progress;
            const pct = p && p.interviewsTotal ? Math.round((p.interviewsDone / p.interviewsTotal) * 100) : 0;
            return (
              <div key={e.id} className={`grid grid-cols-[2.1fr_1.1fr_1.3fr_1.7fr_1fr_1.4fr_132px] items-center gap-4 border-b border-white/[0.05] px-5 py-4 last:border-b-0 ${current ? 'bg-[#7c3aed]/[0.05]' : ''}`}>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className={`truncate text-[15px] font-semibold ${e.stage === 'DONE' ? 'text-[#a0acbe]' : 'text-white'}`}>{e.name}</div>
                  <div className="flex flex-wrap gap-1.5">
                    <StageBadge stage={e.stage} />
                    {current && <Chip tone="current">Current event</Chip>}
                    {e.due && <Chip tone="due">Due</Chip>}
                  </div>
                </div>
                <div className="text-[13px] text-[#c3cad6]">{dateRange(e.startDate, e.endDate)}</div>
                <div className="text-[13px]">
                  {e.stage === 'DONE' ? (
                    <span className="text-[#8694a8]">Marked done {day(e.doneAt)}. Record and audit log kept.</span>
                  ) : !p ? (
                    <span className="text-[#8694a8]">Only visible to its people</span>
                  ) : p.interviewsTotal === 0 ? (
                    <span className="text-[#8694a8]">{e.stage === 'DRAFT' || e.stage === 'ACTIVE' ? `Not started${e.setupMode === 'UPLOAD' ? '. Schedule not uploaded yet.' : '.'}` : 'No interviews recorded'}</span>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[#e8edf5]">{p.interviewsDone} of {p.interviewsTotal} interviews</span>
                      <div className="h-1.5 rounded bg-white/[0.07]" role="img" aria-label={`${pct}% done`}><div className="h-1.5 rounded bg-emerald-500" style={{ width: `${pct}%` }} /></div>
                      {p.daysTotal > 0 && <span className="text-xs text-[#8694a8]">{p.daysClosed} of {p.daysTotal} days closed</span>}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {e.admins.length === 0 && <span className="text-[13px] text-[#8694a8]">No admin (ask a super admin)</span>}
                  {e.admins.map((a) => (
                    <div key={a.userId} className="text-[13px] leading-tight text-[#e8edf5]">
                      {a.name || a.email}{a.userId === user?.id ? <span className="text-[#8694a8]"> (you)</span> : null}
                      <span className="block text-xs text-[#8694a8]">{a.email}</span>
                    </div>
                  ))}
                </div>
                <div className={`text-[13px] ${e.onEvent ? 'text-[#e8edf5]' : 'text-[#8694a8]'}`}>
                  {e.onEvent ? roleLabel(e.myRole) : e.myRole ? 'Super admin' : 'Not assigned to you'}
                </div>
                <div className={`text-[13px] ${e.due ? 'text-red-300' : 'text-[#c3cad6]'}`}>{retentionText(e)}</div>
                <div>
                  {e.myRole ? (
                    <Link href={`/dashboard/events/${e.id}`} className={e.due && e.myRole === 'ADMIN' ? btn.danger : btn.secondary}>
                      {e.due && e.myRole === 'ADMIN' ? 'Review' : e.myRole === 'ADMIN' ? 'Manage' : 'Open'}
                    </Link>
                  ) : e.stage !== 'DONE' ? (
                    <Link href={`/dashboard/events/${e.id}`} className={btn.ghost}>Ask to join</Link>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
