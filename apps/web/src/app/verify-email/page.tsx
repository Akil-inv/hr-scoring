'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { VerifyEmail } from '@akil-inv/auth-kit/react';
import { useAuthStore } from '@/lib/auth-store';
import { AuthFrame } from '@/lib/auth-kit';

/** Confirms a new sign-in email. The change ends every session, so sign in again. */
function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const logout = useAuthStore((s) => s.logout);
  return <VerifyEmail token={token} signInHref="/login" onVerified={() => logout()} />;
}

export default function VerifyEmailPage() {
  return <AuthFrame><Suspense><Verify /></Suspense></AuthFrame>;
}
