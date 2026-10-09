'use client';
import { AccountSecurity } from '@akil-inv/auth-kit/react';
import { useAuthStore } from '@/lib/auth-store';
import { HrAuthKit, toStoredUser } from '@/lib/auth-kit';
import { DocumentPasswordCard } from '@/components/document-password';

/** The signed-in person's password, email, two-factor (when switched on) and HR code. */
export default function AccountPage() {
  const setAuth = useAuthStore((s) => s.setAuth);
  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold text-white">My account</h1>
      <p className="mb-6 mt-1 text-sm text-slate-400">How you sign in, and the HR code for your downloads.</p>
      <HrAuthKit>
        <AccountSecurity onTokenChanged={({ accessToken, user }) => setAuth(accessToken, toStoredUser(user))} />
      </HrAuthKit>
      <DocumentPasswordCard />
    </div>
  );
}
