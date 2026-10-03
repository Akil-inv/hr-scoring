'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import { useEventStore, type EventSummary } from '@/lib/event-store';
import { EVENTS_QUERY, MY_EVENTS_QUERY } from '@/lib/queries';

/**
 * Set to true once UsersModule is registered in app.module.ts and `myEvents`
 * shows up in schema.gql. Until then the graph has no myEvents field and the
 * query fails, so we read the unscoped `events` list.
 */
const USE_MY_EVENTS = false;

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20',
  DRAFT: 'bg-amber-500/10 text-amber-300 ring-amber-400/20',
  COMPLETED: 'bg-sky-500/10 text-sky-300 ring-sky-400/20',
  ARCHIVED: 'bg-white/[0.04] text-[#6b7a90] ring-white/10',
};

function tone(status?: string) {
  return STATUS_TONE[status ?? ''] ?? STATUS_TONE.ARCHIVED;
}

/** Strips the `[GraphQL] ` prefix urql puts on server errors. */
function cleanError(message: string) {
  return message.split('] ').pop() ?? message;
}

export default function EventSelector() {
  const token = useAuthStore((s) => s.token);
  const events = useEventStore((s) => s.events);
  const eventId = useEventStore((s) => s.eventId);
  const event = useEventStore((s) => s.event);
  const loaded = useEventStore((s) => s.loaded);
  const setEvents = useEventStore((s) => s.setEvents);
  const selectEvent = useEventStore((s) => s.selectEvent);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);

    createClient(token)
      .query(USE_MY_EVENTS ? MY_EVENTS_QUERY : EVENTS_QUERY, {})
      .toPromise()
      .then((res) => {
        if (cancelled) return;
        if (res.error) {
          setError(cleanError(res.error.message));
          return;
        }
        const list: EventSummary[] =
          (USE_MY_EVENTS ? res.data?.myEvents : res.data?.events) ?? [];
        setEvents(list);
        setError(null);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message ?? 'Could not load events');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, setEvents]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const shell =
    'w-full rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition-colors';

  if (loading && !loaded) {
    return (
      <div className="px-3 pt-3">
        <div className={`${shell} animate-pulse`}>
          <p className="text-[10px] uppercase tracking-[0.15em] text-[#4a5568]">Event</p>
          <div className="mt-1.5 h-3.5 w-32 rounded bg-white/[0.06]" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 pt-3">
        <div className={`${shell} border-red-500/20 bg-red-500/[0.04]`}>
          <p className="text-[10px] uppercase tracking-[0.15em] text-[#4a5568]">Event</p>
          <p className="mt-1 text-[12px] leading-snug text-red-300">{error}</p>
          <button type="button"
            onClick={() => load()}
            className="mt-1.5 text-[11px] font-medium text-[#a78bfa] hover:text-[#c4b5fd]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="px-3 pt-3">
        <Link
          href="/dashboard/event"
          className={`${shell} block hover:border-[#7c3aed]/30 hover:bg-[#7c3aed]/[0.06]`}
        >
          <p className="text-[10px] uppercase tracking-[0.15em] text-[#4a5568]">Event</p>
          <p className="mt-1 text-[13px] font-medium text-[#8694a8]">No events yet</p>
          <p className="mt-0.5 text-[11px] text-[#a78bfa]">Set one up &rarr;</p>
        </Link>
      </div>
    );
  }

  const only = events.length === 1;

  return (
    <div ref={wrapRef} className="relative px-3 pt-3">
      <button
        type="button"
        onClick={() => !only && setOpen((v) => !v)}
        aria-haspopup={only ? undefined : 'listbox'}
        aria-expanded={only ? undefined : open}
        disabled={only}
        className={`${shell} flex items-center gap-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7c3aed]/50 ${
          only ? 'cursor-default' : 'hover:border-white/10 hover:bg-white/[0.04]'
        }`}
      >
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.15em] text-[#4a5568]">Event</p>
          <p className="mt-0.5 truncate text-[13px] font-medium text-white">
            {event?.name ?? 'Select an event'}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ${tone(
            event?.status,
          )}`}
        >
          {event?.status ?? '—'}
        </span>
        {!only && (
          <span
            className={`shrink-0 text-[10px] text-[#4a5568] transition-transform ${
              open ? 'rotate-180' : ''
            }`}
            aria-hidden
          >
            &#9660;
          </span>
        )}
      </button>

      {open && !only && (
        <div
          role="listbox"
          className="absolute left-3 right-3 z-50 mt-1.5 max-h-72 overflow-y-auto rounded-xl border border-white/[0.08] bg-[#0b1020] p-1.5 shadow-2xl shadow-black/60"
        >
          {events.map((e) => {
            const active = e.id === eventId;
            return (
              <button type="button"
                key={e.id}
                role="option"
                aria-selected={active}
                onClick={() => {
                  selectEvent(e.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  active ? 'bg-[#7c3aed]/15' : 'hover:bg-white/[0.04]'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    active ? 'bg-[#a78bfa]' : 'bg-transparent'
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[13px] ${
                      active ? 'font-medium text-[#a78bfa]' : 'text-[#8694a8]'
                    }`}
                  >
                    {e.name}
                  </span>
                  {e.role && (
                    <span className="block text-[10px] uppercase tracking-wider text-[#4a5568]">
                      {e.role}
                    </span>
                  )}
                </span>
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 ${tone(
                    e.status,
                  )}`}
                >
                  {e.status}
                </span>
              </button>
            );
          })}

          <Link
            href="/dashboard/event"
            onClick={() => setOpen(false)}
            className="mt-1 block border-t border-white/[0.06] px-2.5 pb-1 pt-2 text-[12px] text-[#6b7a90] hover:text-[#a78bfa]"
          >
            Set up a new event
          </Link>
        </div>
      )}
    </div>
  );
}
