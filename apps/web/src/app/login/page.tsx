'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/graphql-client';
import { useAuthStore } from '@/lib/auth-store';
import { LOGIN_MUTATION } from '@/lib/queries';

export default function LoginPage() {
  const [email, setEmail] = useState('admin@hackathon.local');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const client = createClient(null);
      const result = await client.mutation(LOGIN_MUTATION, { input: { email, password } }).toPromise();
      if (result.error) { setError(result.error.message); return; }
      const { accessToken, user } = result.data.login;
      setAuth(accessToken, user);
      router.push('/dashboard');
    } catch (err: any) { setError(err.message || 'Login failed');
    } finally { setLoading(false); }
  };

  return (
    <main className="flex min-h-screen items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-dark-900 via-dark-800 to-dark-900" />
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-info/10 rounded-full blur-3xl" />

      <div className="relative z-10 w-full max-w-sm animate-in">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent/20 border border-accent/30 mb-4">
            <span className="text-accent text-xl">⚡</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Hackathon Judging</h1>
          <p className="text-sm text-slate-400 mt-1">Command Centre</p>
        </div>

        <div className="bg-dark-800/80 backdrop-blur-xl border border-dark-600 rounded-2xl p-8 shadow-2xl shadow-black/40">
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-dark-900/60 border border-dark-600 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-accent focus:ring-1 focus:ring-accent outline-none transition-all" required />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-dark-900/60 border border-dark-600 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-accent focus:ring-1 focus:ring-accent outline-none transition-all" required />
            </div>
            {error && <p className="text-sm text-error bg-error-soft rounded-lg px-3 py-2">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full bg-accent hover:bg-accent/90 text-white rounded-lg px-4 py-3 text-sm font-semibold transition-all disabled:opacity-50 shadow-lg shadow-accent/25">
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </form>
          <p className="mt-5 text-xs text-slate-500 text-center font-mono">admin@hackathon.local / admin123</p>
        </div>
      </div>
    </main>
  );
}
