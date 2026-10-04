'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { AuthRequestsPanel, LinkBox, UserSecurityActions, UserSecurityBadges, useAuthKit, useUserSecurity } from '@akil-inv/auth-kit/react';
import type { Link as AuthLink } from '@akil-inv/auth-kit/client';
import { HrAuthKit } from '@/lib/auth-kit';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import { useEventStore } from '@/lib/event-store';
import EncryptionStatus from '@/components/encryption-status';
import {
  USERS_QUERY,
  EVENT_USERS_QUERY,
  CREATE_USER_MUTATION,
  ASSIGN_EVENT_ROLE_MUTATION,
  REMOVE_EVENT_ROLE_MUTATION,
} from '@/lib/queries';

type User = {
  id: string;
  email: string;
  name: string;
  role: string;
};

type EventUser = {
  userId: string;
  email: string;
  name: string;
  globalRole: string;
  role: string;
};

/** Global roles, from the Role enum in schema.gql. */
const GLOBAL_ROLES = [
  'ADMIN',
  'COORDINATOR',
  'PANEL_CHAIR',
  'AUDITOR',
  'JUDGE',
  'TEAM_REP',
] as const;

/** Per-event roles, from the EventRole enum. Narrower than the global list. */
const EVENT_ROLES = ['ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR'] as const;

const ROLES_THAT_MANAGE_USERS = ['SUPER_ADMIN', 'ADMIN'];

/** Strips the `[GraphQL] ` prefix urql puts on server errors. */
function cleanError(message: string) {
  return message.split('] ').pop() ?? message;
}

const ROLE_TONE: Record<string, string> = {
  SUPER_ADMIN: 'bg-[#7c3aed]/15 text-[#a78bfa] ring-[#7c3aed]/25',
  ADMIN: 'bg-sky-500/10 text-sky-300 ring-sky-400/20',
  COORDINATOR: 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20',
  PANEL_CHAIR: 'bg-amber-500/10 text-amber-300 ring-amber-400/20',
  AUDITOR: 'bg-white/[0.05] text-[#8694a8] ring-white/10',
};

function roleTone(role: string) {
  return ROLE_TONE[role] ?? 'bg-white/[0.05] text-[#8694a8] ring-white/10';
}

export default function UsersPage() {
  return <HrAuthKit><UsersPageInner /></HrAuthKit>;
}

function UsersPageInner() {
  const { client: auth } = useAuthKit();
  const token = useAuthStore((s) => s.token);
  const currentUser = useAuthStore((s) => s.user);
  const eventId = useEventStore((s) => s.eventId);
  const event = useEventStore((s) => s.event);

  const [users, setUsers] = useState<User[]>([]);
  /** userId -> current role on the selected event. */
  const [eventRoles, setEventRoles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    email: '',
    name: '',
    phone: '',
    globalRole: 'COORDINATOR',
  });
  /** The invite link for a user just created. */
  const [invite, setInvite] = useState<AuthLink | null>(null);
  /** Whose sign-in actions are open. */
  const [openUser, setOpenUser] = useState<string | null>(null);

  /** Pending dropdown selections, keyed by userId. Falls back to the saved role. */
  const [roleChoice, setRoleChoice] = useState<Record<string, string>>({});

  const canManage = ROLES_THAT_MANAGE_USERS.includes(currentUser?.role ?? '');
  const { summaries, reload: reloadSecurity } = useUserSecurity(canManage ? users.map((u) => u.id) : []);

  const loadUsers = useCallback(async () => {
    if (!token) return;
    try {
      const res = await createClient(token).query(USERS_QUERY, {}).toPromise();
      if (res.error) {
        setError(cleanError(res.error.message));
        return;
      }
      setUsers(res.data?.users ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load users');
    }
  }, [token]);

  const loadEventRoles = useCallback(async () => {
    if (!token || !eventId) {
      setEventRoles({});
      return;
    }
    try {
      const res = await createClient(token).query(EVENT_USERS_QUERY, { eventId }).toPromise();
      if (res.error) {
        // Non-fatal: the page still works without saved-role display.
        setEventRoles({});
        return;
      }
      const rows: EventUser[] = res.data?.eventUsers ?? [];
      setEventRoles(Object.fromEntries(rows.map((r) => [r.userId, r.role])));
    } catch {
      setEventRoles({});
    }
  }, [token, eventId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadUsers(), loadEventRoles()]);
    setLoading(false);
  }, [loadUsers, loadEventRoles]);

  useEffect(() => {
    if (canManage) loadAll();
    else setLoading(false);
  }, [canManage, loadAll]);

  /** Runs a mutation, surfaces errors, and refreshes on success. */
  const run = async (
    key: string,
    query: string,
    variables: Record<string, any>,
    successMessage: string,
    refresh: 'all' | 'roles' | 'none' = 'all',
  ) => {
    if (!token) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await createClient(token).mutation(query, variables).toPromise();
      if (res.error) {
        setError(cleanError(res.error.message));
        return;
      }
      setNotice(successMessage);
      if (refresh === 'all') await loadAll();
      else if (refresh === 'roles') await loadEventRoles();
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  /** Create the account, then its invite link: the person chooses their own password with it. */
  const createUser = async () => {
    if (!form.email || !form.name) {
      setError('Email and name are required.');
      return;
    }
    if (!token) return;
    setBusy('create');
    setError(null);
    setNotice(null);
    setInvite(null);
    try {
      const res = await createClient(token)
        .mutation(CREATE_USER_MUTATION, {
          input: { email: form.email.trim(), name: form.name.trim(), phone: form.phone.trim() || undefined, globalRole: form.globalRole },
        })
        .toPromise();
      if (res.error) {
        setError(cleanError(res.error.message));
        return;
      }
      const created = res.data.createUser;
      setInvite(await auth.admin.inviteLink(created.id));
      setForm({ email: '', name: '', phone: '', globalRole: 'COORDINATOR' });
      setShowCreate(false);
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const assignRole = (user: User) => {
    if (!eventId) return;
    const role = roleChoice[user.id] ?? eventRoles[user.id] ?? EVENT_ROLES[1];
    return run(
      `assign-${user.id}`,
      ASSIGN_EVENT_ROLE_MUTATION,
      { input: { userId: user.id, eventId, role } },
      `${user.name || user.email} is now ${role} on ${event?.name ?? 'this event'}.`,
      'roles',
    );
  };

  const removeRole = (user: User) => {
    if (!eventId) return;
    return run(
      `remove-${user.id}`,
      REMOVE_EVENT_ROLE_MUTATION,
      { userId: user.id, eventId },
      `Removed ${user.name || user.email} from ${event?.name ?? 'this event'}.`,
      'roles',
    );
  };

  if (!canManage) {
    return (
      <div className="rounded-xl border border-dark-600 bg-dark-800/50 p-8">
        <h1 className="text-lg font-semibold text-white">Users &amp; roles</h1>
        <p className="mt-2 text-sm text-slate-400">
          Managing users requires an admin account. Ask an administrator if you need access.
        </p>
      </div>
    );
  }

  const inputClass =
    'w-full rounded-lg border border-dark-500 bg-dark-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-[#7c3aed]/50';

  const assignedCount = Object.keys(eventRoles).length;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Users &amp; roles</h1>
          <p className="mt-1 text-sm text-slate-400">
            {event?.name
              ? `Event roles apply to ${event.name}. ${assignedCount} assigned.`
              : 'Select an event in the sidebar to assign event roles.'}
          </p>
        </div>
        <button type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-lg shadow-accent/20 hover:bg-accent/90"
        >
          {showCreate ? 'Cancel' : 'Add user'}
        </button>
      </div>

      {currentUser?.role === 'SUPER_ADMIN' && <EncryptionStatus token={token} />}

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {showCreate && (
        <div className="mb-6 rounded-xl border border-dark-600 bg-dark-800/80 p-6">
          <h3 className="mb-4 text-sm font-semibold text-white">New user</h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-slate-400">Full name</label>
              <input
                className={`mt-1 ${inputClass}`}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Priya Menon"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-slate-400">Email</label>
              <input
                type="email"
                className={`mt-1 ${inputClass}`}
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="priya@example.com"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
                Phone (optional)
              </label>
              <input
                className={`mt-1 ${inputClass}`}
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+6591234567"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wider text-slate-400">Global role</label>
              <select
                className={`mt-1 ${inputClass}`}
                value={form.globalRole}
                onChange={(e) => setForm((f) => ({ ...f, globalRole: e.target.value }))}
              >
                {GLOBAL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            No password to set: you&apos;ll get an invite link to send them, and they choose their own.
          </p>
          <div className="mt-5 flex gap-3 border-t border-dark-600 pt-4">
            <button type="button"
              onClick={createUser}
              disabled={busy === 'create'}
              className="rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {busy === 'create' ? 'Creating…' : 'Create and get invite link'}
            </button>
            <button type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-dark-500 bg-dark-700 px-4 py-2 text-sm text-white hover:bg-dark-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {invite && (
        <div className="mb-6">
          <LinkBox link={invite} onClose={() => setInvite(null)} />
        </div>
      )}

      <div className="mb-6">
        <AuthRequestsPanel onChanged={() => { loadAll(); reloadSecurity(); }} />
      </div>

      <div className="overflow-hidden rounded-xl border border-dark-600 bg-dark-800/50">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-dark-600 text-[11px] uppercase tracking-wider text-slate-500">
              <th className="px-5 py-3 font-medium">Person</th>
              <th className="px-5 py-3 font-medium">Global role</th>
              <th className="px-5 py-3 font-medium">Event role</th>
              <th className="px-5 py-3 text-right font-medium">Account</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === currentUser?.id;
              const savedRole = eventRoles[user.id];
              const selected = roleChoice[user.id] ?? savedRole ?? EVENT_ROLES[1];
              const isDirty = savedRole !== undefined && selected !== savedRole;

              return (
                <Fragment key={user.id}>
                <tr className="border-b border-dark-600/50 last:border-0">
                  <td className="px-5 py-4">
                    <p className="text-sm font-medium text-white">
                      {user.name || <span className="text-slate-500">No name set</span>}
                      {isSelf && <span className="ml-2 text-[11px] text-slate-500">you</span>}
                    </p>
                    <p className="text-xs text-slate-400">{user.email}</p>
                    <div className="mt-1"><UserSecurityBadges summary={summaries[user.id]} /></div>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ring-1 ${roleTone(
                        user.role,
                      )}`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <span className="w-24 shrink-0 text-xs">
                        {savedRole ? (
                          <span className="font-medium text-emerald-300">{savedRole}</span>
                        ) : (
                          <span className="text-slate-600">Not assigned</span>
                        )}
                      </span>
                      <select
                        disabled={!eventId}
                        value={selected}
                        onChange={(e) =>
                          setRoleChoice((prev) => ({ ...prev, [user.id]: e.target.value }))
                        }
                        className="rounded-lg border border-dark-500 bg-dark-900/60 px-2 py-1.5 text-xs text-white outline-none disabled:opacity-40"
                      >
                        {EVENT_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button type="button"
                        onClick={() => assignRole(user)}
                        disabled={!eventId || busy === `assign-${user.id}`}
                        className="rounded-lg bg-accent/90 px-2.5 py-1.5 text-xs text-white hover:bg-accent disabled:opacity-40"
                      >
                        {busy === `assign-${user.id}`
                          ? 'Saving…'
                          : isDirty
                            ? 'Change'
                            : savedRole
                              ? 'Reassign'
                              : 'Assign'}
                      </button>
                      <button type="button"
                        onClick={() => removeRole(user)}
                        disabled={!eventId || !savedRole || busy === `remove-${user.id}`}
                        className="rounded-lg border border-dark-500 bg-dark-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-dark-600 disabled:opacity-30"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <button type="button"
                      onClick={() => setOpenUser(openUser === user.id ? null : user.id)}
                      aria-expanded={openUser === user.id}
                      className="rounded-lg border border-dark-500 bg-dark-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-dark-600"
                    >
                      {openUser === user.id ? 'Close' : 'Sign-in…'}
                    </button>
                  </td>
                </tr>
                {openUser === user.id && (
                  <tr className="border-b border-dark-600/50 bg-dark-900/40">
                    <td colSpan={4} className="px-5 py-4">
                      <UserSecurityActions
                        user={user}
                        summary={summaries[user.id]}
                        isSelf={isSelf}
                        onChanged={() => reloadSecurity()}
                        onDeleted={() => { setOpenUser(null); setNotice(`Deleted ${user.email}.`); loadAll(); }}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        {loading && <p className="px-5 py-8 text-center text-sm text-slate-500">Loading users…</p>}
        {!loading && users.length === 0 && !error && (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No users yet. Add one to get started.
          </p>
        )}
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Global roles control what someone can do across the platform. Event roles apply only to the
        selected event.
      </p>
    </div>
  );
}
