'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useEventStore } from '@/lib/event-store';
import { addMonths, CREATE, day, gql, Person } from '@/lib/event-control';
import { btn, card, ErrorNote, input } from '@/components/event-control-ui';

const STAFF_SEARCH = `query($q: String!) { staffSearch(query: $q) { userId name email } }`;
const CHOICES = [3, 4, 5, 6];

/** A new event: name, interview days, how it's set up, how long data is kept, and its admins. */
export default function NewEventPage() {
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const reload = useEventStore((s) => s.reload);

  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [mode, setMode] = useState<'UPLOAD' | 'WIZARD'>('UPLOAD');
  const [months, setMonths] = useState(6);
  const [coAdmins, setCoAdmins] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Person[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setMatches([]); return; }
    const t = setTimeout(() => {
      gql<{ staffSearch: Person[] }>(token, STAFF_SEARCH, { q })
        .then((d) => setMatches(d.staffSearch.filter((p) => !coAdmins.some((c) => c.userId === p.userId))))
        .catch(() => setMatches([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, token, coAdmins]);

  if (user && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    return (
      <div className="mx-auto max-w-[640px] py-10 text-sm text-[#c3cad6]">
        Only admins can create events. <Link href="/dashboard/events" className="text-[#a78bfa]">Back to Event Control</Link>
      </div>
    );
  }

  const endDay = end || start;
  const dueExample = endDay ? day(addMonths(`${endDay}T00:00:00Z`, months)) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Give the event a name.');
    if (!start || !end) return setError('Give the first and last interview days.');
    if (end < start) return setError('The last day is before the first day.');
    setSaving(true);
    try {
      const d = await gql<{ createControlledEvent: { id: string } }>(token, CREATE, {
        i: {
          name: name.trim(), startDate: `${start}T00:00:00Z`, endDate: `${end}T00:00:00Z`,
          setupMode: mode, retentionMonths: months, coAdminUserIds: coAdmins.map((c) => c.userId),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore',
        },
      });
      // Make it the current event, so setting it up happens on it.
      useEventStore.setState({ eventId: d.createControlledEvent.id });
      reload();
      router.push(`/dashboard/events/${d.createControlledEvent.id}?created=1`);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-5">
      <div className="text-[13px] text-[#8694a8]"><Link href="/dashboard/events" className="text-[#a78bfa] hover:text-[#c4b5fd]">Event Control</Link> / New event</div>
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight text-white">New event</h1>
        <p className="mt-1 text-sm text-[#8694a8]">It starts as a draft: only its admins see it until you start it.</p>
      </div>

      <form onSubmit={submit} className={`${card} flex flex-col gap-6`} noValidate>
        <Section>The event</Section>
        <label className="flex flex-col gap-2 text-[13px] font-medium text-[#c3cad6]">Event name
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Graduate Hiring — Nov 2026" required />
        </label>
        <div className="flex flex-wrap gap-4">
          <label className="flex min-w-[200px] flex-1 flex-col gap-2 text-[13px] font-medium text-[#c3cad6]">First interview day
            <input className={input} type="date" value={start} onChange={(e) => { setStart(e.target.value); if (!end || end < e.target.value) setEnd(e.target.value); }} required />
          </label>
          <label className="flex min-w-[200px] flex-1 flex-col gap-2 text-[13px] font-medium text-[#c3cad6]">Last interview day
            <input className={input} type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} required />
          </label>
        </div>

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-[13px] font-medium text-[#c3cad6]">How will you set it up?</legend>
          <div className="flex flex-wrap gap-3">
            {([['UPLOAD', 'Upload the Excel workbook', 'Candidates, panels and the schedule from one file, as today.'], ['WIZARD', 'Step-by-step wizard', 'Enter everything on screen.']] as const).map(([v, title, hint]) => (
              <label key={v} className={`flex min-w-[220px] flex-1 cursor-pointer items-start gap-3 rounded-xl border p-4 ${mode === v ? 'border-[#7c3aed] bg-[#7c3aed]/[0.08]' : 'border-white/10 bg-[#060a14]'}`}>
                <input type="radio" name="mode" checked={mode === v} onChange={() => setMode(v)} className="mt-1 accent-[#7c3aed]" />
                <span><span className="block text-sm font-semibold text-white">{title}</span><span className="text-xs text-[#8694a8]">{hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="h-px bg-white/[0.07]" />
        <Section>Data retention</Section>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] font-medium text-[#c3cad6]">Keep candidate data after the event closes for</legend>
          <div className="flex flex-wrap self-start overflow-hidden rounded-[10px] border border-white/10" role="radiogroup" aria-label="Retention period">
            {CHOICES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={months === m} onClick={() => setMonths(m)}
                className={`min-h-[44px] min-w-[96px] border-r border-white/10 px-4 text-sm font-medium last:border-r-0 ${months === m ? 'bg-[#7c3aed] text-white' : 'bg-[#060a14] text-[#c3cad6] hover:text-white'}`}>
                {m} months
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex gap-3 rounded-xl bg-[#162035] px-4 py-3.5 text-[13px] leading-relaxed text-[#e8edf5]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth="2" className="mt-0.5 shrink-0" aria-hidden><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
          <span>
            The clock starts when the event is closed.
            {dueExample ? <> If it closes on its last day, {day(`${endDay}T00:00:00Z`)}, its candidate data is <strong>due on {dueExample}</strong>.</> : null}
            {' '}Admins are told then; one of them either extends the period or marks the event done. Nothing is removed automatically.
          </span>
        </div>

        <div className="h-px bg-white/[0.07]" />
        <Section>Admins</Section>
        <div className="text-[13px] font-medium text-[#c3cad6]">Who manages this event
          <span className="mt-1 block text-xs font-normal text-[#8694a8]">You&apos;re added automatically. Add co-admins now or later. Every staff user can see who an event&apos;s admins are.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center rounded-full bg-[#162035] px-3 py-1.5 text-[13px] text-white">{user?.email} (you)</span>
          {coAdmins.map((c) => (
            <span key={c.userId} className="inline-flex items-center gap-2 rounded-full bg-[#162035] py-1 pl-3 pr-1 text-[13px] text-white">
              {c.name || c.email}
              <button type="button" aria-label={`Remove ${c.name || c.email}`} onClick={() => setCoAdmins(coAdmins.filter((x) => x.userId !== c.userId))}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.08] text-[#c3cad6] hover:text-white">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </span>
          ))}
        </div>
        <div className="relative">
          <label className="flex flex-col gap-2 text-[13px] font-medium text-[#c3cad6]">Add a co-admin
            <input className={input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or email of an existing user" autoComplete="off" />
          </label>
          {matches.length > 0 && (
            <ul className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-xl border border-white/10 bg-[#0b1020] shadow-2xl">
              {matches.map((m) => (
                <li key={m.userId}>
                  <button type="button" onClick={() => { setCoAdmins([...coAdmins, m]); setQuery(''); setMatches([]); }}
                    className="flex w-full flex-col items-start px-4 py-2.5 text-left text-sm text-white hover:bg-white/[0.05]">
                    {m.name || m.email}<span className="text-xs text-[#8694a8]">{m.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ErrorNote message={error} />
        <div className="flex flex-wrap justify-end gap-2.5 pt-1">
          <Link href="/dashboard/events" className={btn.secondary}>Cancel</Link>
          <button type="submit" className={btn.primary} disabled={saving}>{saving ? 'Creating…' : 'Create draft event'}</button>
        </div>
      </form>
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#a78bfa]">{children}</div>;
}
