'use client';

import { ReactNode, useMemo } from 'react';
import { createAuthClient } from '@akil-inv/auth-kit/client';
import { AuthKitProvider, AuthTheme } from '@akil-inv/auth-kit/react';
import { useAuthStore } from './auth-store';
import { BRAND } from './brand';

/**
 * auth-kit (sign-in, invites, password resets, two-factor, account actions)
 * styled for this app. Routes: /api/auth on the API.
 */
export const hrTheme: Partial<AuthTheme> = {
  card: 'rounded-2xl border border-dark-600 bg-dark-800/80 p-6 shadow-2xl shadow-black/30 backdrop-blur-xl',
  title: 'text-lg font-semibold text-white',
  text: 'text-sm text-slate-300',
  muted: 'text-sm text-slate-400',
  label: 'mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400',
  input: 'w-full rounded-lg border border-dark-600 bg-dark-900/60 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60',
  button: 'inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-accent/25 hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50',
  secondary: 'inline-flex items-center justify-center rounded-lg border border-dark-500 bg-dark-700 px-3 py-2 text-sm text-slate-200 hover:bg-dark-600 disabled:cursor-not-allowed disabled:opacity-40',
  danger: 'inline-flex items-center justify-center rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40',
  error: 'rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-sm text-red-300',
  success: 'rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-sm text-emerald-200',
  link: 'text-sm font-medium text-accent-light hover:text-white',
  code: 'rounded bg-dark-900 px-1.5 py-0.5 font-mono text-sm text-slate-100',
  badge: 'inline-flex items-center rounded-md bg-white/[0.06] px-2 py-0.5 text-[11px] text-slate-300 ring-1 ring-white/10',
  badgeWarn: 'inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-500/20',
  badgeOk: 'inline-flex items-center rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300 ring-1 ring-emerald-500/20',
  divider: 'border-t border-dark-600',
};

export function HrAuthKit({ children }: { children: ReactNode }) {
  const client = useMemo(() => createAuthClient({ baseUrl: '/api/auth', getToken: () => useAuthStore.getState().token }), []);
  return <AuthKitProvider client={client} theme={hrTheme}>{children}</AuthKitProvider>;
}

/** The page frame for sign-in and link pages (no sidebar). */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="absolute inset-0 bg-gradient-to-br from-dark-900 via-dark-800 to-dark-900" />
      <div className="absolute left-1/4 top-1/4 h-96 w-96 rounded-full bg-accent/10 blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 h-64 w-64 rounded-full bg-info/10 blur-3xl" />
      <div className="relative z-10 w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-accent/30 bg-accent/20">
            <span className="text-xl text-accent">✦</span>
          </div>
          <h1 className="text-2xl font-bold text-white">{BRAND.name}</h1>
          <p className="mt-1 text-sm text-slate-400">{BRAND.tagline}</p>
        </div>
        <HrAuthKit>{children}</HrAuthKit>
      </div>
    </main>
  );
}

/** The app keeps the signed-in user as { id, email, role }. */
export const toStoredUser = (u: { id: string; email: string; role?: unknown }) => ({ id: u.id, email: u.email, role: String(u.role ?? '') });
