const statusConfig: Record<string, { bg: string; text: string; dot?: string }> = {
  DRAFT: { bg: 'bg-white/5 border-white/10', text: 'text-[#6b7a90]' },
  ACTIVE: { bg: 'bg-[#10b981]/10 border-[#10b981]/20', text: 'text-[#34d399]', dot: 'bg-[#10b981]' },
  ELIGIBLE: { bg: 'bg-[#10b981]/10 border-[#10b981]/20', text: 'text-[#34d399]' },
  COMPLETED: { bg: 'bg-[#3b82f6]/10 border-[#3b82f6]/20', text: 'text-[#60a5fa]' },
  ARCHIVED: { bg: 'bg-white/5 border-white/10', text: 'text-[#4a5568]' },
  SUBMITTED: { bg: 'bg-[#7c3aed]/10 border-[#7c3aed]/20', text: 'text-[#a78bfa]' },
  SCHEDULED: { bg: 'bg-[#3b82f6]/10 border-[#3b82f6]/20', text: 'text-[#60a5fa]' },
  IN_PROGRESS: { bg: 'bg-[#10b981]/10 border-[#10b981]/20', text: 'text-[#34d399]', dot: 'bg-[#10b981]' },
  JUDGED: { bg: 'bg-[#f59e0b]/10 border-[#f59e0b]/20', text: 'text-[#fbbf24]' },
  DISQUALIFIED: { bg: 'bg-[#ef4444]/10 border-[#ef4444]/20', text: 'text-[#f87171]' },
  UNAVAILABLE: { bg: 'bg-[#ef4444]/10 border-[#ef4444]/20', text: 'text-[#f87171]' },
  CANCELLED: { bg: 'bg-[#ef4444]/10 border-[#ef4444]/20', text: 'text-[#f87171]' },
  NO_SHOW: { bg: 'bg-[#ef4444]/10 border-[#ef4444]/20', text: 'text-[#f87171]' },
  DELAYED: { bg: 'bg-[#f59e0b]/10 border-[#f59e0b]/20', text: 'text-[#fbbf24]', dot: 'bg-[#f59e0b]' },
  WITHDRAWN: { bg: 'bg-[#ef4444]/10 border-[#ef4444]/20', text: 'text-[#f87171]' },
  RESOLVED: { bg: 'bg-white/5 border-white/10', text: 'text-[#4a5568]' },
  LOCKED: { bg: 'bg-[#f59e0b]/10 border-[#f59e0b]/20', text: 'text-[#fbbf24]' },
  PROVISIONAL: { bg: 'bg-[#f59e0b]/10 border-[#f59e0b]/20', text: 'text-[#fbbf24]' },
  APPROVED: { bg: 'bg-[#10b981]/10 border-[#10b981]/20', text: 'text-[#34d399]' },
  PUBLISHED: { bg: 'bg-[#7c3aed]/10 border-[#7c3aed]/20', text: 'text-[#a78bfa]' },
  NOT_STARTED: { bg: 'bg-white/5 border-white/10', text: 'text-[#4a5568]' },
  RESUBMITTED: { bg: 'bg-[#3b82f6]/10 border-[#3b82f6]/20', text: 'text-[#60a5fa]' },
  REOPENED: { bg: 'bg-[#f59e0b]/10 border-[#f59e0b]/20', text: 'text-[#fbbf24]' },
  TECHNICAL: { bg: 'bg-[#3b82f6]/10 border-[#3b82f6]/20', text: 'text-[#60a5fa]' },
  BUSINESS: { bg: 'bg-[#10b981]/10 border-[#10b981]/20', text: 'text-[#34d399]' },
  DOMAIN: { bg: 'bg-[#7c3aed]/10 border-[#7c3aed]/20', text: 'text-[#a78bfa]' },
  INNOVATION: { bg: 'bg-[#f59e0b]/10 border-[#f59e0b]/20', text: 'text-[#fbbf24]' },
  EXECUTIVE: { bg: 'bg-[#ef4444]/10 border-[#ef4444]/20', text: 'text-[#f87171]' },
};

export default function StatusBadge({ status }: { status: string }) {
  const c = statusConfig[status] || { bg: 'bg-white/5 border-white/10', text: 'text-[#4a5568]' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] ${c.bg} ${c.text}`}>
      {c.dot && <span className={`w-1.5 h-1.5 rounded-full ${c.dot} animate-pulse`} />}
      {status.replace(/_/g, ' ')}
    </span>
  );
}
