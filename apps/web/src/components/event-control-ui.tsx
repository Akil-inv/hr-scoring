'use client';

import { useEffect, useRef } from 'react';
import { STAGES } from '@/lib/event-control';

export function StageBadge({ stage }: { stage: string }) {
  const s = STAGES[stage] ?? STAGES.ARCHIVED;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${s.tone}`}>{s.label}</span>;
}

export function Chip({ children, tone }: { children: React.ReactNode; tone: 'current' | 'due' }) {
  const cls = tone === 'current' ? 'bg-[#7c3aed]/15 text-[#c4b5fd] ring-[#7c3aed]/30' : 'bg-red-500/10 text-red-300 ring-red-400/25';
  return <span className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${cls}`}>{children}</span>;
}

export const btn = {
  primary: 'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-[10px] bg-[#7c3aed] px-4 text-sm font-medium text-white transition hover:bg-[#6d28d9] disabled:cursor-not-allowed disabled:opacity-50',
  secondary: 'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-[10px] border border-white/10 bg-[#162035] px-4 text-sm font-medium text-[#e8edf5] transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-50',
  ghost: 'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-[10px] border border-[#7c3aed]/40 px-4 text-sm font-medium text-[#c4b5fd] transition hover:bg-[#7c3aed]/10',
  danger: 'inline-flex min-h-[40px] items-center justify-center gap-2 rounded-[10px] border border-red-500/40 px-4 text-sm font-medium text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50',
  dangerSolid: 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[10px] bg-red-700 px-4 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50',
  warnSolid: 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[10px] bg-amber-700 px-4 text-sm font-medium text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50',
  small: 'inline-flex min-h-[34px] items-center justify-center rounded-[9px] border border-white/10 bg-[#162035] px-3 text-[13px] text-[#e8edf5] transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40',
};

export const input = 'min-h-[42px] w-full rounded-[10px] border border-white/10 bg-[#060a14] px-3 text-sm text-[#e8edf5] outline-none placeholder:text-[#6b7a90] focus:border-[#7c3aed] focus:ring-2 focus:ring-[#7c3aed]/20';
export const card = 'rounded-2xl border border-white/[0.07] bg-[#0c1220] p-5 sm:p-6';

export function ErrorNote({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-sm text-red-200">
      <span className="flex-1">{message}</span>
      {onClose && <button type="button" onClick={onClose} className="text-xs text-red-300 hover:text-white">Dismiss</button>}
    </div>
  );
}

/** A modal dialog: Escape and the backdrop close it; focus moves into it. */
export function Dialog({ title, children, onClose, danger }: { title: string; children: React.ReactNode; onClose: () => void; danger?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-10" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={`w-full max-w-[560px] rounded-[18px] border bg-[#0c1220] p-6 shadow-2xl shadow-black/60 sm:p-7 ${danger ? 'border-red-500/35' : 'border-white/10'}`}>
        <h2 className="mb-4 text-lg font-semibold text-white">{title}</h2>
        {children}
      </div>
    </div>
  );
}
