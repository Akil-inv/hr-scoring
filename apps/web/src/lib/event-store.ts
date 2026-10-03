'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Event context for the whole dashboard.
 *
 * Every page below /dashboard is scoped to one event. Before this store, each
 * page independently ran EVENTS_QUERY and grabbed `events[0]`, which silently
 * broke the moment a second event existed. Pages should now read `eventId`
 * from here instead.
 *
 * The selected id is persisted to localStorage so a refresh keeps you on the
 * same event. Only the id is persisted — the event objects are re-fetched on
 * load so stale names/statuses never linger.
 */

export type EventSummary = {
  id: string;
  name: string;
  status: string;
  /** Present from `events`, absent from `myEvents`. Both are handled. */
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string | null;
  location?: string | null;
  /** Per-event role. Only populated once `myEvents` is wired. */
  role?: string | null;
};

type EventState = {
  eventId: string | null;
  event: EventSummary | null;
  events: EventSummary[];
  /** True once setEvents has run at least once — distinguishes "no events" from "not loaded". */
  loaded: boolean;

  setEvents: (events: EventSummary[]) => void;
  selectEvent: (id: string) => void;
  clear: () => void;
};

export const useEventStore = create<EventState>()(
  persist(
    (set, get) => ({
      eventId: null,
      event: null,
      events: [],
      loaded: false,

      setEvents: (events) => {
        const current = get().eventId;
        // Keep the persisted selection if it still exists, otherwise fall back
        // to the first ACTIVE event, then to the first event of any status.
        const stillValid = current !== null && events.some((e) => e.id === current);
        const nextId = stillValid
          ? current
          : events.find((e) => e.status === 'ACTIVE')?.id ?? events[0]?.id ?? null;

        set({
          events,
          eventId: nextId,
          event: events.find((e) => e.id === nextId) ?? null,
          loaded: true,
        });
      },

      selectEvent: (id) => {
        const found = get().events.find((e) => e.id === id);
        if (!found) return;
        set({ eventId: id, event: found });
      },

      clear: () => set({ eventId: null, event: null, events: [], loaded: false }),
    }),
    {
      name: 'hackjudge-event',
      // Persist the selection only. Event data is always re-fetched.
      partialize: (state) => ({ eventId: state.eventId }),
    },
  ),
);

/** Convenience selector — most pages only need the id. */
export const useEventId = () => useEventStore((s) => s.eventId);

/** Convenience selector — for pages that show the event name or timezone. */
export const useCurrentEvent = () => useEventStore((s) => s.event);
