'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';

/**
 * The document password: every report PDF and Excel file a person downloads
 * is locked with it (on the server, at download). It is theirs alone, set here,
 * and never the sign-in password.
 */

type Status = { set: boolean; setAt: string | null };

function useDocumentPassword() {
  const token = useAuthStore((s) => s.token);
  const [status, setStatus] = useState<Status | null>(null);
  const load = useCallback(async () => {
    if (!token) return;
    const res = await fetch('/api/document-password', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setStatus(await res.json());
  }, [token]);
  useEffect(() => { load(); }, [load]);
  return { token, status, reload: load };
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/** On My account: set or change it. */
export function DocumentPasswordCard() {
  const { token, status, reload } = useDocumentPassword();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [signIn, setSignIn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (password !== confirm) { setMsg({ tone: 'err', text: 'The two document passwords do not match.' }); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/document-password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password, signInPassword: signIn }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.message === 'string' ? body.message : `Could not save it (${res.status}).`);
      setPassword(''); setConfirm(''); setSignIn(''); setOpen(false);
      setMsg({ tone: 'ok', text: 'Saved. Files you download from now on open with this password.' });
      reload();
    } catch (err: any) {
      setMsg({ tone: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-lg border border-dark-500 bg-dark-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-accent focus:outline-none';

  return (
    <section id="document-password" className="mt-6 rounded-2xl border border-dark-600 bg-dark-800 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Document password</h2>
          <p className="mt-1 text-sm text-slate-400">
            Report PDFs and Excel files you download are locked with this password, so only you can open them.
            They can be printed, but not copied from or edited. Keep it different from your sign-in password.
          </p>
          {status && (
            <p className={`mt-2 text-sm ${status.set ? 'text-emerald-300' : 'text-amber-300'}`}>
              {status.set ? `Set ${when(status.setAt)}.` : 'Not set yet: downloads are refused until you set it.'}
            </p>
          )}
        </div>
        {!open && (
          <button type="button" onClick={() => { setOpen(true); setMsg(null); }}
            className="shrink-0 rounded-lg border border-dark-500 px-3 py-2 text-sm text-slate-200 hover:border-accent/60">
            {status?.set ? 'Change' : 'Set it'}
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={submit} className="mt-4 grid max-w-md gap-3">
          <label className="grid gap-1 text-sm text-slate-300">
            New document password
            <input type="password" autoComplete="new-password" className={field} value={password}
              onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </label>
          <label className="grid gap-1 text-sm text-slate-300">
            Type the document password again
            <input type="password" autoComplete="new-password" className={field} value={confirm}
              onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          <label className="grid gap-1 text-sm text-slate-300">
            Your sign-in password, to confirm it is you
            <input type="password" autoComplete="current-password" className={field} value={signIn}
              onChange={(e) => setSignIn(e.target.value)} required />
          </label>
          <p className="text-xs text-slate-500">
            At least 10 characters. If you forget it, set a new one here and download the files again;
            files you downloaded before keep the old password.
          </p>
          <div className="flex gap-2">
            <button type="submit" disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40">
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setMsg(null); }}
              className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          </div>
        </form>
      )}

      {msg && <p role="status" className={`mt-3 text-sm ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</p>}
    </section>
  );
}

/** Next to download buttons: a warning when it isn't set, a reminder when it is. */
export function DocumentPasswordNotice() {
  const { status } = useDocumentPassword();
  if (!status) return null;
  if (!status.set) {
    return (
      <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
        Downloads are locked with your personal document password, and you haven&apos;t set one yet.{' '}
        <Link href="/dashboard/account#document-password" className="font-medium underline">Set it in My account</Link>.
      </div>
    );
  }
  return (
    <p className="mb-3 text-xs text-slate-500">
      🔒 Files you download open with your document password. <Link href="/dashboard/account#document-password" className="underline hover:text-slate-300">Change it</Link>
    </p>
  );
}

/** A failed download or action, above the page; links to My account when the document password is the reason. */
export function ActionError({ message, onClose }: { message: string | null; onClose: () => void }) {
  if (!message) return null;
  const aboutPassword = /document password/i.test(message);
  return (
    <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-2.5 text-sm text-red-300">
      <span>
        {message}
        {aboutPassword && <> <Link href="/dashboard/account#document-password" className="font-medium underline">Go to My account</Link>.</>}
      </span>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="text-red-300/70 hover:text-red-200">✕</button>
    </div>
  );
}
