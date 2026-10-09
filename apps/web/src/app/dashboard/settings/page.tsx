'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { gql } from '@/lib/event-control';
import { btn, card, Dialog, ErrorNote, input } from '@/components/event-control-ui';

/**
 * Settings (super admins): platform-wide switches for features some teams
 * don't want. Nothing is removed by switching off; switching back on brings
 * the feature back as it was.
 */

type Settings = { fileProtection: boolean; twoFactor: boolean; updatedAt: string | null };
type Key = 'fileProtection' | 'twoFactor';

const QUERY = `query { platformSettings { fileProtection twoFactor updatedAt } }`;
const UPDATE = `mutation($i: PlatformSettingsInput!, $p: String!) { updatePlatformSettings(input: $i, signInPassword: $p) { fileProtection twoFactor updatedAt } }`;

const SWITCHES: { key: Key; title: string; on: string; off: string }[] = [
  {
    key: 'fileProtection',
    title: 'File passwords on downloads',
    on: "Every report PDF and Excel file opens with the first four letters of its name + the downloader's HR code. Files can be printed, not copied or edited.",
    off: 'Reports and Excel files download without a password, and nobody needs an HR code. Downloads are still recorded in the audit log.',
  },
  {
    key: 'twoFactor',
    title: 'Two-factor sign-in',
    on: 'People can turn on a 6-digit code from an authenticator app (My account), and are asked for it at every sign-in.',
    off: "Nobody is asked for a code and the option is hidden. Anyone who had set it up keeps their set-up: it applies again if you switch this back on.",
  },
];

export default function SettingsPage() {
  const { token, user } = useAuthStore();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [change, setChange] = useState<{ key: Key; to: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSettings((await gql<{ platformSettings: Settings }>(token, QUERY)).platformSettings); } catch (e: any) { setError(e.message); }
  }, [token]);
  useEffect(() => { if (token) load(); }, [token, load]);

  if (user && user.role !== 'SUPER_ADMIN') {
    return <div className="max-w-3xl"><h1 className="text-2xl font-semibold text-white">Settings</h1><p className="mt-2 text-sm text-slate-400">Only a super admin can change platform settings.</p></div>;
  }

  const close = () => { setChange(null); setPassword(''); setError(null); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!change) return;
    setBusy(true); setError(null);
    try {
      const out = (await gql<{ updatePlatformSettings: Settings }>(token, UPDATE, { i: { [change.key]: change.to }, p: password })).updatePlatformSettings;
      setSettings(out);
      const s = SWITCHES.find((x) => x.key === change.key)!;
      setSaved(`${s.title} switched ${change.to ? 'on' : 'off'}.`);
      close();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pending = change && SWITCHES.find((x) => x.key === change.key)!;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-white">Settings</h1>
      <p className="mt-1 text-sm text-slate-400">Switch features on or off for everyone on the platform. Switching off removes nothing; switch back on at any time.</p>

      {saved && <p role="status" className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-200">{saved}</p>}
      {!change && <div className="mt-4"><ErrorNote message={error} onClose={() => setError(null)} /></div>}

      <div className="mt-6 space-y-4">
        {SWITCHES.map((s) => {
          const on = settings?.[s.key];
          return (
            <section key={s.key} className={card}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-semibold text-white">{s.title}</h2>
                    {settings && (
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${on ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20' : 'bg-white/[0.05] text-[#a0acbe] ring-white/10'}`}>
                        {on ? 'On' : 'Off'}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm text-slate-400">{settings ? (on ? s.on : s.off) : 'Loading…'}</p>
                </div>
                {settings && (
                  <button type="button" className={on ? btn.secondary : btn.primary} onClick={() => { setSaved(null); setChange({ key: s.key, to: !on }); }}>
                    {on ? 'Switch off…' : 'Switch on…'}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {settings?.updatedAt && <p className="mt-4 text-xs text-slate-500">Last changed {new Date(settings.updatedAt).toLocaleString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}. Every change is in the audit log.</p>}

      {change && pending && (
        <Dialog title={`Switch ${pending.title.toLowerCase()} ${change.to ? 'on' : 'off'}?`} onClose={close} danger={!change.to}>
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-slate-300">{change.to ? pending.on : pending.off}</p>
            <p className="text-sm text-slate-400">This applies to everyone, straight away.</p>
            <label className="grid gap-1.5 text-sm text-slate-300">
              Your sign-in password, to confirm
              <input type="password" autoComplete="current-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            <ErrorNote message={error} />
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={busy || !password} className={change.to ? btn.primary : btn.warnSolid}>
                {busy ? 'Saving…' : `Switch ${change.to ? 'on' : 'off'}`}
              </button>
              <button type="button" className={btn.secondary} onClick={close}>Cancel</button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
