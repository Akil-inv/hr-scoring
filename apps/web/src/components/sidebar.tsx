'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth-store';
import { useEventStore } from '@/lib/event-store';
import EventSelector from './event-selector';

type NavItem = {
  label: string;
  href: string;
  icon: string;
  /** Global roles allowed to see this item. Omit for everyone. */
  roles?: string[];
};

const navItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: '\u229E' },
  { label: 'Event Setup', href: '/dashboard/event', icon: '⚙' },
  { label: 'Schedule', href: '/dashboard/schedule', icon: '📅' },
  { label: 'Command Centre', href: '/dashboard/operations', icon: '▶' },
  { label: 'Scoring', href: '/dashboard/scoring', icon: '\uD83D\uDCCA' },
  { label: 'Rankings', href: '/dashboard/rankings', icon: '\uD83C\uDFC6' },
  { label: 'Conflicts', href: '/dashboard/conflicts', icon: '\u26A0' },
  { label: 'Judge Links', href: '/dashboard/judge-links', icon: '\u2709' },
  { label: 'Audit Log', href: '/dashboard/audit', icon: '\uD83D\uDCCB' },
  {
    label: 'Users & roles',
    href: '/dashboard/users',
    icon: '\uD83D\uDC65',
    roles: ['SUPER_ADMIN', 'ADMIN'],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const clearEvent = useEventStore((s) => s.clear);

  const visibleItems = navItems.filter(
    (item) => !item.roles || item.roles.includes(user?.role ?? ''),
  );

  const signOut = () => {
    clearEvent();
    logout();
    router.push('/login');
  };

  return (
    <aside className="flex h-screen w-64 flex-col bg-[#060a14] border-r border-white/[0.06]">
      <div className="px-6 py-5 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#7c3aed] to-[#6d28d9] flex items-center justify-center shadow-lg shadow-[#7c3aed]/20">
            <span className="text-white text-sm">{'\u26A1'}</span>
          </div>
          <div>
            <h1 className="text-[15px] font-semibold text-white tracking-tight">HackJudge</h1>
            <p className="text-[10px] text-[#4a5568] font-medium uppercase tracking-[0.15em]">Platform</p>
          </div>
        </div>
      </div>

      <EventSelector />

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {visibleItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.href} href={item.href}
              className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14px] font-medium transition-all duration-200 ${
                isActive
                  ? 'bg-[#7c3aed]/15 text-[#a78bfa] shadow-sm'
                  : 'text-[#6b7a90] hover:bg-white/[0.03] hover:text-[#8694a8]'
              }`}>
              <span className="text-base w-6 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-white/[0.06] px-4 py-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#7c3aed]/30 to-[#6d28d9]/20 flex items-center justify-center text-sm font-semibold text-[#a78bfa] ring-1 ring-[#7c3aed]/20">
            {user?.email?.[0]?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-[#8694a8] truncate">{user?.email}</p>
            <p className="text-[10px] text-[#7c3aed] font-semibold uppercase tracking-wider">{user?.role}</p>
          </div>
        </div>
        <button type="button" onClick={signOut}
          className="text-[12px] text-[#4a5568] hover:text-[#ef4444] transition-colors">
          Sign out
        </button>
      </div>
    </aside>
  );
}
