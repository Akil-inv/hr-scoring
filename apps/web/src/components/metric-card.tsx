export default function MetricCard({ label, value, icon, trend, color = 'accent' }: {
  label: string; value: string | number; icon: string; trend?: string; color?: string;
}) {
  const colorConfig: Record<string, { bg: string; border: string; text: string; glow: string }> = {
    accent: { bg: 'from-[#7c3aed]/15 to-[#7c3aed]/5', border: 'border-[#7c3aed]/15', text: 'text-[#a78bfa]', glow: 'shadow-[#7c3aed]/5' },
    success: { bg: 'from-[#10b981]/15 to-[#10b981]/5', border: 'border-[#10b981]/15', text: 'text-[#34d399]', glow: 'shadow-[#10b981]/5' },
    warning: { bg: 'from-[#f59e0b]/15 to-[#f59e0b]/5', border: 'border-[#f59e0b]/15', text: 'text-[#fbbf24]', glow: 'shadow-[#f59e0b]/5' },
    error: { bg: 'from-[#ef4444]/15 to-[#ef4444]/5', border: 'border-[#ef4444]/15', text: 'text-[#f87171]', glow: 'shadow-[#ef4444]/5' },
    info: { bg: 'from-[#3b82f6]/15 to-[#3b82f6]/5', border: 'border-[#3b82f6]/15', text: 'text-[#60a5fa]', glow: 'shadow-[#3b82f6]/5' },
  };
  const c = colorConfig[color] || colorConfig.accent;

  return (
    <div className={`relative overflow-hidden rounded-2xl border ${c.border} bg-gradient-to-br ${c.bg} backdrop-blur-sm p-5 shadow-lg ${c.glow} animate-in`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-semibold text-[#6b7a90] uppercase tracking-[0.1em]">{label}</p>
          <p className="mt-2 text-3xl font-bold text-white tracking-tight">{value}</p>
          {trend && <p className="mt-1.5 text-[12px] text-[#6b7a90]">{trend}</p>}
        </div>
        <span className={`text-2xl ${c.text} opacity-50`}>{icon}</span>
      </div>
    </div>
  );
}
