'use client';

/**
 * Event Control: queries, labels and dates shared by its pages.
 */

export type Person = { userId: string; name: string; email: string };
export type Member = Person & { role: string; addedAt: string; addedBy: string | null };
export type Progress = { candidates: number; interviewsDone: number; interviewsTotal: number; daysClosed: number; daysTotal: number };

export type ControlledEvent = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  stage: 'DRAFT' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED' | 'DONE' | string;
  setupMode: string;
  startDate: string;
  endDate: string;
  closedAt: string | null;
  doneAt: string | null;
  retentionMonths: number;
  retentionExtraMonths: number;
  retainUntil: string | null;
  due: boolean;
  createdAt: string;
  myRole: string | null;
  onEvent: boolean;
  admins: Person[];
  progress: Progress | null;
};

export type EventDetail = ControlledEvent & {
  people: Member[];
  recentChanges: { at: string; by: string; what: string }[];
  doneRemoves: string[];
  doneKeeps: string[];
};

const EVENT_FIELDS = `id name description status stage setupMode startDate endDate closedAt doneAt retentionMonths retentionExtraMonths retainUntil due createdAt myRole onEvent
  admins { userId name email } progress { candidates interviewsDone interviewsTotal daysClosed daysTotal }`;

export const DIRECTORY = `query { eventDirectory { ${EVENT_FIELDS} } }`;
export const DETAIL = `query($e: String!) { eventControl(eventId: $e) { ${EVENT_FIELDS}
  people { userId name email role addedAt addedBy } recentChanges { at by what } doneRemoves doneKeeps } }`;
export const CREATE = `mutation($i: NewEventInput!) { createControlledEvent(input: $i) { id name } }`;
export const START = `mutation($e: String!) { startEvent(eventId: $e) { id } }`;
export const CLOSE = `mutation($e: String!) { closeControlledEvent(eventId: $e) { id } }`;
export const ARCHIVE = `mutation($e: String!) { archiveEvent(eventId: $e) { id } }`;
export const SET_RETENTION = `mutation($e: String!, $m: Int!) { setEventRetention(eventId: $e, months: $m) { id } }`;
export const EXTEND = `mutation($e: String!, $m: Int!, $r: String!) { extendEventRetention(eventId: $e, months: $m, reason: $r) { id } }`;
export const MARK_DONE = `mutation($e: String!, $n: String!, $p: String!) { markEventDone(eventId: $e, confirmName: $n, password: $p) { id } }`;
export const DELETE_DRAFT = `mutation($e: String!, $n: String) { deleteDraftEvent(eventId: $e, confirmName: $n) }`;
export const SEARCH = `query($e: String!, $q: String!) { eventPeopleSearch(eventId: $e, query: $q) { userId name email } }`;
export const ADD = `mutation($e: String!, $u: String!, $r: String!) { addEventPerson(eventId: $e, userId: $u, role: $r) }`;
export const CHANGE = `mutation($e: String!, $u: String!, $r: String!) { changeEventPersonRole(eventId: $e, userId: $u, role: $r) }`;
export const REMOVE = `mutation($e: String!, $u: String!) { removeEventPerson(eventId: $e, userId: $u) }`;
export const USERS = `query { users { id name email role } }`;

/** One GraphQL call, never cached; the server's message on failure. */
export async function gql<T = any>(token: string | null, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(process.env.NEXT_PUBLIC_API_URL || '/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (body?.errors?.length) {
    const e = body.errors[0];
    const original = e?.extensions?.originalError;
    const msg = (Array.isArray(original?.message) ? original.message.join(' ') : original?.message) || e.message || 'Something went wrong.';
    const err = new Error(msg) as Error & { code?: string };
    err.code = original?.code ?? e?.extensions?.code;
    throw err;
  }
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return body.data as T;
}

export const ROLES = [
  { value: 'ADMIN', label: 'Admin' },
  { value: 'COORDINATOR', label: 'Coordinator' },
  { value: 'PANEL_CHAIR', label: 'Panel chair' },
  { value: 'AUDITOR', label: 'Auditor' },
];
export const roleLabel = (r?: string | null) => ROLES.find((x) => x.value === r)?.label ?? (r === 'SUPER_ADMIN' ? 'Super admin' : r ?? '');

export const STAGES: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Draft', tone: 'bg-amber-500/10 text-amber-300 ring-amber-400/20' },
  ACTIVE: { label: 'Active', tone: 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20' },
  CLOSED: { label: 'Closed', tone: 'bg-sky-500/10 text-sky-300 ring-sky-400/20' },
  ARCHIVED: { label: 'Archived', tone: 'bg-white/[0.05] text-[#a0acbe] ring-white/10' },
  DONE: { label: 'Done · record only', tone: 'bg-white/[0.05] text-[#a0acbe] ring-white/10' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 14 Nov 2026 (dates are stored at midnight UTC, so read them in UTC). */
export function day(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function dateRange(a: string, b: string): string {
  const x = new Date(a), y = new Date(b);
  if (x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth()) {
    return x.getUTCDate() === y.getUTCDate() ? day(a) : `${x.getUTCDate()} – ${day(b)}`;
  }
  return x.getUTCFullYear() === y.getUTCFullYear() ? `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} – ${day(b)}` : `${day(a)} – ${day(b)}`;
}
/** When the change was made, in the viewer's time. */
export function when(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** Same rule as the server: n months later, on the same day or the month's last. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const dayOf = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dayOf, last));
  return d.toISOString();
}

export function retentionText(e: ControlledEvent): string {
  const months = e.retentionMonths + e.retentionExtraMonths;
  const base = `${months} month${months === 1 ? '' : 's'} after close`;
  if (e.stage === 'DONE') return '—';
  if (e.due) return `${base} · ended ${day(e.retainUntil)}`;
  if (e.retainUntil) return `${base} · due ${day(e.retainUntil)}`;
  return base;
}

export const initials = (name: string, email: string) =>
  ((name || email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')) || '?';
