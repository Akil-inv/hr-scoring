/**
 * One answer to "what time is it, where the event is happening".
 *
 * Timestamps are stored in UTC, which is correct. But an event happens in a
 * place, and almost every question the platform asks about time is really a
 * question about that place: is this slot in the morning, which day does it
 * belong to, is this judge available now.
 *
 * `Event.timezone` has existed since the beginning and nothing ever read it.
 * So each site invented its own answer instead — the web app hardcoded
 * 'Asia/Singapore', the scheduler assumed UTC hours below four meant morning,
 * and the availability import built its windows in raw UTC, which put every
 * PM-only judge outside every judging slot.
 *
 * Three separate bugs, one missing abstraction. This is that abstraction.
 *
 * Everything here uses Intl rather than a date library: it is built in, it
 * handles daylight saving, and it needs no dependency.
 */

/** Midday, the boundary between AM and PM for availability purposes. */
const NOON_HOUR = 12;

/**
 * The hour of day at a timestamp, in the event's timezone.
 *
 * `new Date(x).getHours()` gives the server's timezone and `getUTCHours()`
 * gives UTC. Neither is the event's, which is the only one that matters.
 */
export function localHour(date: Date | string, timezone: string): number {
  const d = typeof date === 'string' ? new Date(date) : date;
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false,
  }).format(d);
  return parseInt(hour, 10);
}

/** The calendar date at a timestamp, in the event's timezone, as YYYY-MM-DD. */
export function localDate(date: Date | string, timezone: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Whether a timestamp falls in the morning where the event is happening. */
export function isMorning(date: Date | string, timezone: string): boolean {
  return localHour(date, timezone) < NOON_HOUR;
}

/** 'AM' or 'PM', in the event's timezone. */
export function halfDay(date: Date | string, timezone: string): 'AM' | 'PM' {
  return isMorning(date, timezone) ? 'AM' : 'PM';
}

/**
 * A UTC instant for a wall-clock time on a given date in a timezone.
 *
 * The awkward direction. Given "09:00 on 28 August in Singapore", produce the
 * UTC timestamp — which is what availability windows need, since a judge saying
 * they are free in the morning means their morning, not Greenwich's.
 *
 * Works by taking the offset at that moment rather than assuming a fixed one,
 * so it stays correct across a daylight saving boundary.
 */
export function zonedTimeToUtc(
  dateISO: string,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const [y, m, d] = dateISO.split('-').map(Number);

  // Start from the naive UTC interpretation, then correct by the offset that
  // timezone actually had at that instant.
  const naive = Date.UTC(y, m - 1, d, hour, minute, 0);
  const offset = offsetMinutes(new Date(naive), timezone);
  return new Date(naive - offset * 60_000);
}

/** How far ahead of UTC a timezone was at a given instant, in minutes. */
function offsetMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  );

  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * The window a half-day covers, as UTC instants.
 *
 * AM runs from midnight to noon local, PM from noon to midnight. A judge
 * available in the afternoon is available from noon where they are being asked
 * to judge — not from noon UTC, which for Singapore is eight in the evening.
 */
export function halfDayWindow(
  dateISO: string,
  session: 'AM' | 'PM' | 'BOTH',
  timezone: string,
): { start: Date; end: Date } {
  if (session === 'AM') {
    return {
      start: zonedTimeToUtc(dateISO, 0, 0, timezone),
      end: zonedTimeToUtc(dateISO, NOON_HOUR, 0, timezone),
    };
  }
  if (session === 'PM') {
    return {
      start: zonedTimeToUtc(dateISO, NOON_HOUR, 0, timezone),
      end: zonedTimeToUtc(dateISO, 23, 59, timezone),
    };
  }
  return {
    start: zonedTimeToUtc(dateISO, 0, 0, timezone),
    end: zonedTimeToUtc(dateISO, 23, 59, timezone),
  };
}

/**
 * Fall back to Singapore rather than UTC when an event has no timezone set.
 *
 * The schema default is 'UTC', which was never a considered choice — it is what
 * you get when nobody decides. Every event so far has been in Singapore, and an
 * event that genuinely runs on UTC will say so.
 */
export function eventTimezone(event: { timezone?: string | null } | null): string {
  const tz = event?.timezone;
  if (!tz || tz === 'UTC') return 'Asia/Singapore';
  return tz;
}
