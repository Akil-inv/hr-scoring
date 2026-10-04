'use client';
import { AccountSecurity } from '@akil-inv/auth-kit/react';
import { useAuthStore } from '@/lib/auth-store';
import { HrAuthKit, toStoredUser } from '@/lib/auth-kit';

/** The signed-in person's password, email and two-factor. */
export default function AccountPage() {
  const setAuth = useAuthStore((s) => s.setAuth);
  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold text-white">My account</h1>
      <p className="mb-6 mt-1 text-sm text-slate-400">Your password, sign-in email and two-factor sign-in.</p>
      <HrAuthKit>
        <AccountSecurity onTokenChanged={({ accessToken, user }) => setAuth(accessToken, toStoredUser(user))} />
      </HrAuthKit>
    </div>
  );
}
