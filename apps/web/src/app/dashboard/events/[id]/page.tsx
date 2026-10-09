'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useEventId, useEventStore } from '@/lib/event-store';
import {
  ADD, addMonths, ARCHIVE, WHOLE_NUMBERS, CHANGE, CLOSE, ControlledEvent, DELETE_DRAFT, DETAIL, DIRECTORY, EventDetail, EXTEND, MARK_DONE, Person,
  REMOVE, ROLES, roleLabel, SEARCH, SET_RETENTION, START, dateRange, day, gql, initials, when,
} from '@/lib/event-control';
import { btn, card, Chip, Dialog, ErrorNote, input, StageBadge } from '@/components/event-control-ui';

type Modal = null | 'close' | 'extend' | 'done' | 'delete';

export default function Page() {
  return <Suspense fallback={null}><EventPage /></Suspense>;
}

/** One event: its lifecycle, people, retention and recent changes. */
function EventPage() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created') === '1';
  const router = useRouter();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const currentId = useEventId();
  const reloadEvents = useEventStore((s) => s.reload);

  const [ev, setEv] = useState<EventDetail | null>(null);
  const [outside, setOutside] = useState<ControlledEvent | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(async () => {
    try {
      const d = await gql<{ eventControl: EventDetail }>(token, DETAIL, { e: id });
      setEv(d.eventControl);
    } catch (e: any) {
      if (e.code === 'not_on_event' || /not on this event/i.test(e.message)) {
        // Not on it: show who to ask, from the list everyone can see.
        const d = await gql<{ eventDirectory: ControlledEvent[] }>(token, DIRECTORY).catch(() => null);
        const found = d?.eventDirectory.find((x) => x.id === id) ?? null;
        if (found) setOutside(found); else setMissing(true);
      } else if (/not found/i.test(e.message)) setMissing(true);
      else setError(e.message);
    }
  }, [token, id]);
  useEffect(() => { load(); }, [load]);

  const act = async (query: string, vars: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await gql(token, query, vars);
      after?.();
      await load();
      reloadEvents();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (missing) return <Centered><h1 className="text-xl font-semibold text-white">Event not found</h1><Back /></Centered>;
  if (outside) return <NotOnEvent e={outside} />;
  if (!ev) return <div className="py-12 text-center text-sm text-[#8694a8]">{error ?? 'Loading…'}</div>;

  const admin = ev.myRole === 'ADMIN';
  const done = ev.stage === 'DONE';
  const current = ev.id === currentId;
  const p = ev.progress;
  const closeDue = addMonths(new Date().toISOString(), ev.retentionMonths + ev.retentionExtraMonths);

  const workOnIt = () => {
    const store = useEventStore.getState();
    if (store.events.some((x) => x.id === ev.id)) store.selectEvent(ev.id);
    else { useEventStore.setState({ eventId: ev.id, event: null }); reloadEvents(); }
    router.push(ev.setupMode === 'UPLOAD' ? (p && p.interviewsTotal > 0 ? '/dashboard/schedule' : '/dashboard/upload') : '/dashboard/event');
  };

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
      <div className="text-[13px] text-[#8694a8]"><Link href="/dashboard/events" className="text-[#a78bfa] hover:text-[#c4b5fd]">Event Control</Link> / {ev.name}</div>

      {created && ev.stage === 'DRAFT' && (
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-[#7c3aed]/30 bg-[#7c3aed]/[0.08] px-5 py-4 text-sm text-[#e8edf5]">
          <span className="min-w-[240px] flex-1"><strong>{ev.name}</strong> is created as a draft and is now your current event. Next, set it up{ev.setupMode === 'UPLOAD' ? ' from the Excel workbook' : ' with the wizard'}; start it when it&apos;s ready.</span>
          <button type="button" onClick={workOnIt} className={btn.primary}>{ev.setupMode === 'UPLOAD' ? 'Upload the workbook' : 'Open the wizard'}</button>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-[26px] font-semibold tracking-tight text-white">{ev.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#8694a8]">
            <StageBadge stage={ev.stage} />
            {current && <Chip tone="current">Current event</Chip>}
            {ev.due && <Chip tone="due">Due</Chip>}
            <span>{dateRange(ev.startDate, ev.endDate)} · {ev.setupMode === 'UPLOAD' ? 'set up from the Excel workbook' : 'set up with the wizard'} · you&apos;re {roleLabel(ev.myRole)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {!done && !current && <button type="button" className={btn.secondary} onClick={workOnIt}>Work on this event</button>}
          {admin && ev.stage === 'DRAFT' && <button type="button" className={btn.danger} disabled={busy} onClick={() => setModal('delete')}>Delete draft</button>}
          {admin && ev.stage === 'DRAFT' && <button type="button" className={btn.primary} disabled={busy} onClick={() => act(START, { e: ev.id })}>Start event</button>}
          {admin && ev.stage === 'ACTIVE' && <button type="button" className={btn.danger} disabled={busy} onClick={() => setModal('close')}>Close event</button>}
          {admin && ev.stage === 'CLOSED' && <button type="button" className={btn.secondary} disabled={busy} onClick={() => act(ARCHIVE, { e: ev.id })}>Archive</button>}
          {admin && ev.due && <button type="button" className={btn.danger} onClick={() => setModal('done')}>Mark as done…</button>}
        </div>
      </div>

      <ErrorNote message={error} onClose={() => setError(null)} />

      {ev.due && admin && (
        <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.07] px-5 py-4 text-sm leading-relaxed text-[#e8edf5]">
          Its retention period ended on {day(ev.retainUntil)}. Extend it if the data is still needed, or mark the event done to remove the candidate data and keep the record.
        </div>
      )}

      <Lifecycle ev={ev} />

      <div className="flex flex-wrap items-start gap-5">
        <People ev={ev} admin={admin} me={user?.id} busy={busy} act={act} token={token} />

        <div className="flex min-w-0 flex-[2_1_340px] flex-col gap-5">
          <section className={`${card} flex flex-col gap-3`}>
            <h2 className="text-base font-semibold text-white">Data retention</h2>
            {done ? (
              <p className="text-sm text-[#c3cad6]">Marked done on {day(ev.doneAt)}. Candidate data was removed; the event&apos;s record and audit log are kept.</p>
            ) : (
              <>
                <label className="flex flex-col gap-1.5 text-[13px] text-[#8694a8]">Keep candidate data after the event closes for
                  <select className={input} value={ev.retentionMonths} disabled={!admin || busy}
                    onChange={(e) => act(SET_RETENTION, { e: ev.id, m: Number(e.target.value) })}>
                    {[3, 4, 5, 6].map((m) => <option key={m} value={m}>{m} months</option>)}
                  </select>
                </label>
                {ev.retentionExtraMonths > 0 && <p className="text-[13px] text-[#c3cad6]">Extended by {ev.retentionExtraMonths} month{ev.retentionExtraMonths === 1 ? '' : 's'} (see recent changes for why).</p>}
                <div className="rounded-[10px] bg-[#162035] px-3.5 py-3 text-[13px] leading-relaxed text-[#e8edf5]">
                  {ev.retainUntil
                    ? <>Closed on {day(ev.closedAt)}. {ev.due ? <>Its data was due on <strong>{day(ev.retainUntil)}</strong>.</> : <>Its data is kept until <strong>{day(ev.retainUntil)}</strong>.</>}</>
                    : <>If closed today, its data is kept until <strong>{day(closeDue)}</strong>.</>}
                </div>
                {admin && <button type="button" className={`${btn.small} self-start`} onClick={() => setModal('extend')}>Extend retention…</button>}
                <p className="text-xs leading-relaxed text-[#8694a8]">The clock starts on the day the event is closed. Any admin can extend it, before or after the date passes, with a reason; each extension is in the audit log. Nothing is removed automatically.</p>
              </>
            )}
          </section>

          {!done && <ScoringSteps ev={ev} admin={admin} busy={busy} onChange={(on) => act(WHOLE_NUMBERS, { e: ev.id, on })} />}

          {p && (
            <section className={`${card} flex flex-col gap-3`}>
              <h2 className="text-base font-semibold text-white">Progress</h2>
              <div className="grid grid-cols-3 gap-2.5">
                <Stat n={p.interviewsDone} of={p.interviewsTotal} label="interviews" />
                <Stat n={p.daysClosed} of={p.daysTotal} label="days closed" />
                <Stat n={p.candidates} label="candidates" />
              </div>
            </section>
          )}

          <section className={`${card} flex flex-col gap-2.5`}>
            <h2 className="text-base font-semibold text-white">Recent changes</h2>
            {ev.recentChanges.length === 0 && <p className="text-[13px] text-[#8694a8]">None yet.</p>}
            {ev.recentChanges.map((c, i) => (
              <div key={i} className="text-[13px] leading-snug text-[#e8edf5]"><span className="text-[#8694a8]">{when(c.at)} · {c.by} ·</span> {c.what}</div>
            ))}
            {(ev.myRole === 'ADMIN' || ev.myRole === 'AUDITOR') && current && <Link href="/dashboard/audit" className="text-[13px] text-[#a78bfa] hover:text-[#c4b5fd]">Full audit log</Link>}
          </section>
        </div>
      </div>

      {modal === 'close' && <CloseDialog ev={ev} until={closeDue} busy={busy} onClose={() => setModal(null)} onConfirm={() => act(CLOSE, { e: ev.id }, () => setModal(null))} />}
      {modal === 'extend' && <ExtendDialog ev={ev} busy={busy} onClose={() => setModal(null)} onConfirm={(m, r) => act(EXTEND, { e: ev.id, m, r }, () => setModal(null))} error={error} />}
      {modal === 'delete' && <DeleteDraftDialog ev={ev} busy={busy} error={error} onClose={() => setModal(null)}
        onConfirm={async (name) => {
          setBusy(true);
          setError(null);
          try {
            await gql(token, DELETE_DRAFT, { e: ev.id, n: name || null });
            reloadEvents();
            router.push(`/dashboard/events?deleted=${encodeURIComponent(ev.name)}`);
          } catch (e: any) {
            setError(e.message);
            setBusy(false);
          }
        }} />}
      {modal === 'done' && <DoneDialog ev={ev} busy={busy} onClose={() => setModal(null)} onExtend={() => setModal('extend')} onConfirm={(n, pw) => act(MARK_DONE, { e: ev.id, n, p: pw }, () => setModal(null))} error={error} />}
    </div>
  );
}

function Lifecycle({ ev }: { ev: EventDetail }) {
  const order = ['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED', 'DONE'];
  const at = order.indexOf(ev.stage);
  const steps: { title: string; note: string }[] = [
    { title: 'Draft', note: `Created ${day(ev.createdAt)}` },
    { title: 'Active', note: at >= 1 ? 'Interviews and scoring' : 'Start it when it\'s set up' },
    { title: 'Closed', note: ev.closedAt ? `Closed ${day(ev.closedAt)}` : ev.setupMode === 'UPLOAD' ? 'Needs every interview day closed' : 'Scores lock, judge links stop' },
    { title: 'Archived', note: 'Read-only; reports stay available until it\'s done' },
    { title: 'Done · record only', note: ev.doneAt ? `Marked done ${day(ev.doneAt)}` : `From ${ev.retainUntil ? day(ev.retainUntil) : `${ev.retentionMonths + ev.retentionExtraMonths} months after closing`}, when an admin marks it done` },
  ];
  return (
    <section className={card} aria-label="Lifecycle">
      <ol className="grid grid-cols-1 gap-4 sm:grid-cols-5">
        {steps.map((s, i) => {
          const state = i < at ? 'done' : i === at ? 'now' : 'later';
          return (
            <li key={s.title} className="flex flex-col gap-2" aria-current={state === 'now' ? 'step' : undefined}>
              <div className="flex items-center gap-2">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${state === 'done' ? 'bg-emerald-500/20' : state === 'now' ? 'bg-[#7c3aed] ring-4 ring-[#7c3aed]/25' : i === 4 ? 'border-2 border-dashed border-red-400/45' : 'border-2 border-white/20'}`}>
                  {state === 'done' && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6ee7b7" strokeWidth="3" aria-hidden><path d="M5 12l5 5L20 7" /></svg>}
                  {state === 'now' && <span className="h-2 w-2 rounded-full bg-white" />}
                </span>
                {i < 4 && <span className={`hidden h-0.5 flex-1 sm:block ${i < at ? 'bg-emerald-500' : 'bg-white/10'}`} />}
              </div>
              <div className={`text-sm font-semibold ${state === 'now' ? 'text-[#c4b5fd]' : 'text-white'}`}>{s.title}{state === 'now' ? ' · now' : ''}</div>
              <div className="text-xs text-[#8694a8]">{s.note}</div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function People({ ev, admin, me, busy, act, token }: {
  ev: EventDetail; admin: boolean; me?: string; busy: boolean; token: string | null;
  act: (q: string, v: Record<string, unknown>, after?: () => void) => Promise<boolean>;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Person[]>([]);
  const [pick, setPick] = useState<Person | null>(null);
  const [role, setRole] = useState('COORDINATOR');
  useEffect(() => {
    const q = query.trim();
    if (!admin || q.length < 2 || pick) { setMatches([]); return; }
    const t = setTimeout(() => {
      gql<{ eventPeopleSearch: Person[] }>(token, SEARCH, { e: ev.id, q }).then((d) => setMatches(d.eventPeopleSearch)).catch(() => setMatches([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, admin, token, ev.id, pick]);

  const admins = ev.people.filter((p) => p.role === 'ADMIN');
  const groups = ROLES.map((r) => ({ ...r, people: ev.people.filter((p) => p.role === r.value) })).filter((g) => g.people.length);
  return (
    <section className={`${card} flex min-w-0 flex-[3_1_520px] flex-col gap-1`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-white">People on this event · {ev.people.length}</h2>
        <span className="text-xs text-[#8694a8]">Admins are listed to every staff user; the others only to people on this event.</span>
      </div>
      {groups.map((g) => (
        <div key={g.value}>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8694a8]">{g.label}s · {g.people.length}</div>
          {g.people.map((p) => {
            const lastAdmin = p.role === 'ADMIN' && admins.length === 1;
            return (
              <div key={p.userId} className="flex flex-wrap items-center gap-3 border-t border-white/[0.05] py-3 first:border-t-0">
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-[#7c3aed]/20 text-[13px] font-semibold text-[#c4b5fd]" aria-hidden>{initials(p.name, p.email)}</span>
                <div className="min-w-[180px] flex-1">
                  <div className="text-sm text-white">{p.name || p.email}{p.userId === me && <span className="text-[#8694a8]"> (you)</span>}</div>
                  <div className="text-xs text-[#8694a8]">{p.email}{p.addedBy ? ` · added ${day(p.addedAt)} by ${p.addedBy}` : ''}</div>
                </div>
                {admin && (
                  <>
                    <label className="sr-only" htmlFor={`role-${p.userId}`}>Role for {p.name || p.email}</label>
                    <select id={`role-${p.userId}`} value={p.role} disabled={busy || lastAdmin}
                      title={lastAdmin ? 'The last admin can\'t be changed: add another admin first.' : undefined}
                      onChange={(e) => act(CHANGE, { e: ev.id, u: p.userId, r: e.target.value })}
                      className="min-h-[34px] rounded-[9px] border border-white/10 bg-[#060a14] px-2.5 text-[13px] text-white disabled:opacity-50">
                      {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                    <button type="button" className={btn.small} disabled={busy || lastAdmin}
                      title={lastAdmin ? 'An event always keeps at least one admin.' : undefined}
                      onClick={() => { if (confirm(`Remove ${p.name || p.email} from ${ev.name}?`)) act(REMOVE, { e: ev.id, u: p.userId }); }}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {admin && (
        <form className="mt-3 flex flex-wrap items-end gap-2.5 border-t border-white/[0.07] pt-4"
          onSubmit={(e) => { e.preventDefault(); if (pick) act(ADD, { e: ev.id, u: pick.userId, r: role }, () => { setPick(null); setQuery(''); }); }}>
          <div className="relative min-w-[240px] flex-[2_1_240px]">
            <label className="flex flex-col gap-1.5 text-[13px] text-[#8694a8]">Add a person
              <input className={input} type="search" value={pick ? (pick.name || pick.email) : query} autoComplete="off"
                onChange={(e) => { setPick(null); setQuery(e.target.value); }} placeholder="Name or email of an existing user" />
            </label>
            {matches.length > 0 && (
              <ul className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-xl border border-white/10 bg-[#0b1020] shadow-2xl">
                {matches.map((m) => (
                  <li key={m.userId}>
                    <button type="button" onClick={() => { setPick(m); setMatches([]); }} className="flex w-full flex-col items-start px-4 py-2.5 text-left text-sm text-white hover:bg-white/[0.05]">
                      {m.name || m.email}<span className="text-xs text-[#8694a8]">{m.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex min-w-[140px] flex-[1_1_140px] flex-col gap-1.5 text-[13px] text-[#8694a8]">
            <label htmlFor="add-role">Role</label>
            <select id="add-role" className={input} value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <button type="submit" className={btn.primary} disabled={!pick || busy}>Add to event</button>
        </form>
      )}
      {admin && <p className="mt-2 text-xs text-[#8694a8]">Any admin of this event can add or remove people here. The last admin can&apos;t be removed or changed to another role, so an event is never left without one. Someone without an account needs a super admin to create it first (Users &amp; roles).</p>}
    </section>
  );
}

function CloseDialog({ ev, until, busy, onClose, onConfirm }: { ev: EventDetail; until: string; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const p = ev.progress;
  const open = p ? p.daysTotal - p.daysClosed : 0;
  return (
    <Dialog title={`Close ${ev.name}?`} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-[#e8edf5]">
        {ev.setupMode === 'UPLOAD' && (!p || p.daysTotal === 0
          ? <p className="text-amber-300">No interviews have been scheduled yet. An interview event can be closed once its days have been run and closed.</p>
          : open > 0
            ? <p className="text-amber-300">{open} interview day{open === 1 ? ' is' : 's are'} still open. Close every day on the Results page first.</p>
            : <p className="text-emerald-300">All {p.daysTotal} interview days are closed.</p>)}
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#8694a8]">What happens</div>
        <ul className="list-disc space-y-1 pl-5">
          <li>Judge links stop working. Scores and decisions are locked.</li>
          <li>Reports and exports stay available to the people on the event.</li>
          <li>The {ev.retentionMonths + ev.retentionExtraMonths}-month retention period starts. Candidate data becomes due on <strong>{day(until)}</strong>.</li>
        </ul>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2.5">
        <button type="button" className={btn.secondary} onClick={onClose}>Cancel</button>
        <button type="button" className={btn.warnSolid} disabled={busy || (ev.setupMode === 'UPLOAD' && (!p || p.daysTotal === 0 || open > 0))} onClick={onConfirm}>Close event</button>
      </div>
    </Dialog>
  );
}

function ExtendDialog({ ev, busy, onClose, onConfirm, error }: { ev: EventDetail; busy: boolean; error: string | null; onClose: () => void; onConfirm: (months: number, reason: string) => void }) {
  const [months, setMonths] = useState(3);
  const [reason, setReason] = useState('');
  const newUntil = ev.retainUntil ? addMonths(ev.retainUntil, months) : null;
  return (
    <Dialog title={`Keep ${ev.name}'s data longer`} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onConfirm(months, reason); }}>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[#c3cad6]">Extend by
          <select className={input} value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[1, 2, 3, 6, 9, 12].map((m) => <option key={m} value={m}>{m} month{m === 1 ? '' : 's'}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[#c3cad6]">Why is the data still needed?
          <textarea className={`${input} min-h-[84px] py-2`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. A candidate has appealed the decision" required />
        </label>
        <p className="text-[13px] text-[#c3cad6]">{newUntil ? <>Kept until <strong>{day(newUntil)}</strong> instead of {day(ev.retainUntil)}.</> : <>Adds {months} month{months === 1 ? '' : 's'} to the {ev.retentionMonths} months after closing.</>} The reason goes in the audit log.</p>
        <ErrorNote message={error} />
        <div className="flex flex-wrap justify-end gap-2.5">
          <button type="button" className={btn.secondary} onClick={onClose}>Cancel</button>
          <button type="submit" className={btn.primary} disabled={busy || reason.trim().length < 5}>Extend</button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDraftDialog({ ev, busy, error, onClose, onConfirm }: { ev: EventDetail; busy: boolean; error: string | null; onClose: () => void; onConfirm: (name: string) => void }) {
  const [name, setName] = useState('');
  const candidates = ev.progress?.candidates ?? 0;
  const ready = candidates === 0 || name.trim() === ev.name.trim();
  return (
    <Dialog title={`Delete the draft ${ev.name}?`} onClose={onClose} danger>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (ready) onConfirm(name); }}>
        <p className="text-sm leading-relaxed text-[#c3cad6]">
          It disappears from Event Control and the event list for everyone on it. It was never started, so no judging has happened.
          {' '}Its creation and deletion stay in the audit log.
        </p>
        {candidates > 0 ? (
          <>
            <p className="rounded-xl bg-red-500/[0.08] px-3.5 py-3 text-[13px] leading-relaxed text-[#e8edf5]">
              It already has <strong>{candidates} candidate{candidates === 1 ? '' : 's'}</strong>. Their names, contact details and any notes are removed, the same as when an event is marked done. This can&apos;t be undone.
            </p>
            <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[#c3cad6]">Type the event name to confirm
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={ev.name} autoComplete="off" />
            </label>
          </>
        ) : (
          <p className="text-[13px] text-[#8694a8]">It has no candidates, so no personal data is involved.</p>
        )}
        <ErrorNote message={error} />
        <div className="flex flex-wrap justify-end gap-2.5">
          <button type="button" className={btn.secondary} onClick={onClose}>Keep it</button>
          <button type="submit" className={btn.dangerSolid} disabled={busy || !ready}>{busy ? 'Deleting…' : 'Delete draft'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function DoneDialog({ ev, busy, onClose, onExtend, onConfirm, error }: { ev: EventDetail; busy: boolean; error: string | null; onClose: () => void; onExtend: () => void; onConfirm: (name: string, password: string) => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Dialog title={`Mark ${ev.name} as done`} onClose={onClose} danger>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onConfirm(name, password); }}>
        <p className="text-sm leading-relaxed text-[#c3cad6]">Its retention period (from closing on {day(ev.closedAt)}) ended on {day(ev.retainUntil)}. The event becomes a record only. This can&apos;t be undone; if the data is still needed, extend instead.</p>
        <div className="flex flex-wrap gap-4">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1.5 rounded-xl bg-red-500/[0.08] p-3.5 text-[13px] leading-snug text-[#e8edf5]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-red-300">Removed</div>
            {ev.doneRemoves.map((x) => <span key={x}>{x}</span>)}
          </div>
          <div className="flex min-w-[200px] flex-1 flex-col gap-1.5 rounded-xl bg-[#162035] p-3.5 text-[13px] leading-snug text-[#e8edf5]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#8694a8]">Kept as the event&apos;s record</div>
            {ev.doneKeeps.map((x) => <span key={x}>{x}</span>)}
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[#c3cad6]">Type the event name to confirm
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={ev.name} autoComplete="off" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-[#c3cad6]">Your sign-in password
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        <ErrorNote message={error} />
        <div className="flex flex-wrap justify-end gap-2.5">
          <button type="button" className={btn.secondary} onClick={onExtend}>Extend retention…</button>
          <button type="submit" className={btn.dangerSolid} disabled={busy || name.trim() !== ev.name.trim() || !password}>Mark as done</button>
        </div>
      </form>
    </Dialog>
  );
}

function NotOnEvent({ e }: { e: ControlledEvent }) {
  return (
    <Centered>
      <section className={`${card} flex flex-col gap-4`}>
        <span className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-[#7c3aed]/15" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
        </span>
        <div>
          <h1 className="text-[22px] font-semibold text-white">You&apos;re not on this event</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[#8694a8]">
            <span className="font-medium text-white">{e.name}</span><StageBadge stage={e.stage} /><span>{dateRange(e.startDate, e.endDate)}</span>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-[#c3cad6]">Its candidates, scores, schedules and reports are visible only to the people on it. To get access, ask one of its admins to add you.</p>
        <div className="border-t border-white/[0.07]">
          {e.admins.length === 0 && <p className="py-3 text-sm text-[#8694a8]">It has no admin at the moment; ask a super admin.</p>}
          {e.admins.map((a) => (
            <div key={a.userId} className="flex flex-wrap items-center gap-3.5 border-b border-white/[0.05] py-3.5 last:border-b-0">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sm font-semibold text-sky-300" aria-hidden>{initials(a.name, a.email)}</span>
              <div className="min-w-[180px] flex-1"><div className="text-sm font-medium text-white">{a.name || a.email}</div><div className="text-[13px] text-[#8694a8]">{a.email} · Admin</div></div>
              <a className={btn.secondary} href={`mailto:${a.email}?subject=${encodeURIComponent(`Access to ${e.name}`)}`}>Email {(a.name || a.email).split(' ')[0]}</a>
            </div>
          ))}
        </div>
        <Back />
      </section>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto mt-6 flex max-w-[640px] flex-col gap-4">{children}</div>;
}
function Back() {
  return <Link href="/dashboard/events" className={`${btn.primary} self-start`}>Back to Event Control</Link>;
}
function Stat({ n, of, label }: { n: number; of?: number; label: string }) {
  return (
    <div>
      <div className="text-[22px] font-semibold text-white">{n}{of !== undefined && <span className="text-[13px] text-[#8694a8]"> / {of}</span>}</div>
      <div className="text-xs text-[#8694a8]">{label}</div>
    </div>
  );
}

/** A score just under 4 on this step: 3.75 for 0.25, 3.5 for 0.5, 3.9 for 0.1. */
const example = (step: number) => String(Math.round((3 + Math.floor(0.99 / step) * step) * 100) / 100);

/** Whole numbers only, or the rubric's own steps (e.g. 3.75). Fixed once a judge starts scoring. */
function ScoringSteps({ ev, admin, busy, onChange }: { ev: EventDetail; admin: boolean; busy: boolean; onChange: (on: boolean) => void }) {
  const fractions = ev.rubricStep !== null && ev.rubricStep < 1;
  const locked = ev.scoringStarted;
  const now = ev.wholeNumberScores || !fractions
    ? <>Judges score in <strong>whole numbers</strong> (e.g. 3 or 4).</>
    : <>Judges can score in steps of <strong>{ev.rubricStep}</strong> (e.g. {example(ev.rubricStep ?? 0.25)}), as the rubric allows.</>;
  return (
    <section className={`${card} flex flex-col gap-3`}>
      <h2 className="text-base font-semibold text-white">Scoring</h2>
      <p className="text-sm text-[#c3cad6]">{now}</p>
      <label className={`flex items-start gap-3 text-sm ${admin && !locked ? 'text-[#e8edf5]' : 'text-[#8694a8]'}`}>
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#7c3aed]" checked={ev.wholeNumberScores}
          disabled={!admin || locked || busy} onChange={(e) => onChange(e.target.checked)} />
        <span>Whole numbers only{ev.rubricStep === null ? ' (whatever steps the rubric allows when it is uploaded)' : fractions ? ` (instead of steps of ${ev.rubricStep})` : ''}</span>
      </label>
      <p className="text-xs leading-relaxed text-[#8694a8]">
        {locked
          ? 'Judges have started scoring, so this is fixed for the event: every candidate is scored the same way.'
          : 'Can be changed until the first judge starts scoring. The rubric itself is not changed.'}
      </p>
    </section>
  );
}
