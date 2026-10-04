'use client';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ResetPasswordForm } from '@akil-inv/auth-kit/react';
import { useAuthStore } from '@/lib/auth-store';
import { AuthFrame, toStoredUser } from '@/lib/auth-kit';

/** Opens invite links (first password) and password reset links. */
function Reset() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  return <ResetPasswordForm token={token} onSignedIn={({ accessToken, user }) => { setAuth(accessToken, toStoredUser(user)); router.push('/dashboard/schedule'); }} />;
}

export default function ResetPasswordPage() {
  return <AuthFrame><Suspense><Reset /></Suspense></AuthFrame>;
}
