'use client';
import { useRouter } from 'next/navigation';
import { LoginForm } from '@akil-inv/auth-kit/react';
import { useAuthStore } from '@/lib/auth-store';
import { AuthFrame, toStoredUser } from '@/lib/auth-kit';

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  return (
    <AuthFrame>
      <LoginForm onSignedIn={({ accessToken, user }) => { setAuth(accessToken, toStoredUser(user)); router.push('/dashboard/schedule'); }} />
    </AuthFrame>
  );
}
