'use client';
interface Column<T> { key: string; label: string; render?: (row: T) => React.ReactNode; }
interface DataTableProps<T> { columns: Column<T>[]; data: T[]; loading?: boolean; emptyMessage?: string; }

export default function DataTable<T extends Record<string, any>>({ columns, data, loading, emptyMessage = 'No data yet' }: DataTableProps<T>) {
  if (loading) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0c1220]/70 backdrop-blur-sm overflow-hidden">
      {[...Array(5)].map((_, i) => <div key={i} className="h-16 border-b border-white/[0.04] shimmer" />)}
    </div>
  );
  if (data.length === 0) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0c1220]/70 backdrop-blur-sm py-20 text-center">
      <div className="w-12 h-12 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4a5568" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <p className="text-[#6b7a90] text-sm">{emptyMessage}</p>
    </div>
  );

  return (
    <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-[#0c1220]/70 backdrop-blur-sm">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/[0.06]">
            {columns.map((col) => (
              <th key={col.key} className="px-5 py-4 text-left text-[11px] font-semibold text-[#4a5568] uppercase tracking-[0.1em]">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-b border-white/[0.03] last:border-0 data-row animate-in" style={{ animationDelay: `${i * 25}ms` }}>
              {columns.map((col) => (
                <td key={col.key} className="px-5 py-4 text-sm text-[#8694a8]">{col.render ? col.render(row) : row[col.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
