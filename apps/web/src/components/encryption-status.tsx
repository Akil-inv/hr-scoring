'use client';

import { useEffect, useState } from 'react';

/**
 * Super admins: what protects candidate data at rest. Read-only; changes are
 * made by whoever runs the server (encryption.sh).
 */
type Status = {
  mode: 'kms' | 'local' | 'recovery' | 'off';
  source: string;
  keys: { version: number; protectedBy: string; createdAt: string; recoveryKitPrintedAt: string | null; fingerprint: string | null }[];
  values: { encrypted: number; plain: number };
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export default function EncryptionStatus({ token }: { token: string | null }) {
  const [s, setS] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/encryption', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setS)
      .catch(() => setFailed(true));
  }, [token]);

  if (failed || !s) return null;
  const kitMissing = s.mode !== 'off' && s.keys.some((k) => !k.recoveryKitPrintedAt);
  const [tone, title, detail] =
    s.mode === 'kms'
      ? ['ok', 'Candidate data is encrypted', `Key held by AWS KMS (${s.source}).`]
      : s.mode === 'local'
        ? ['ok', 'Candidate data is encrypted', 'Key held on the server (no AWS KMS).']
        : s.mode === 'recovery'
          ? ['warn', 'Running on the recovery key', 'AWS KMS was unavailable; the server was started with the break-glass key. Ask whoever runs the server to restore KMS.']
          : ['warn', 'Encryption is off', 'Candidate data is stored unencrypted. Whoever runs the server can turn it on.'];
  const ring = tone === 'ok' ? 'border-emerald-500/20 bg-emerald-500/[0.05]' : 'border-amber-500/25 bg-amber-500/[0.07]';

  return (
    <div className={`mb-6 rounded-xl border px-4 py-3 text-sm ${ring}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-white">{title}</p>
        <p className="text-xs text-slate-400 tabular-nums">
          {s.values.encrypted.toLocaleString()} values encrypted{s.values.plain ? `, ${s.values.plain.toLocaleString()} not yet` : ''}
        </p>
      </div>
      <p className="mt-0.5 text-slate-400">{detail}</p>
      {s.keys.map((k) => (
        <p key={k.version} className="mt-1 text-xs text-slate-500">
          Key v{k.version} · since {day(k.createdAt)} · recovery kit{' '}
          {k.recoveryKitPrintedAt ? `printed ${day(k.recoveryKitPrintedAt)}` : <span className="text-amber-300">never printed</span>}
        </p>
      ))}
      {kitMissing && (
        <p className="mt-1.5 text-xs text-amber-300">
          Without a printed recovery kit, losing access to the key would lock the data. Ask whoever runs the server to run ./encryption.sh recovery-kit and store it offline.
        </p>
      )}
    </div>
  );
}
