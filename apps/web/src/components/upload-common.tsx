'use client';

/** Shared by the setup and candidate uploads. */

export type Issue = { sheet: string; row: number | null; message: string };

export function dayLabel(iso: string) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

/** Nest sends message as a string, an array, or (for our 400s) alongside an errors list. */
export function messageOf(body: any, fallback: string): string {
  const m = body?.message;
  if (Array.isArray(m)) return m.join(' ');
  if (typeof m === 'string') return m;
  return fallback;
}

export function IssueList({ title, tone, issues }: { title: string; tone: 'error' | 'warning'; issues: Issue[] }) {
  if (issues.length === 0) return null;
  const dot = tone === 'error' ? 'bg-error' : 'bg-warning';
  return (
    <div className="rounded-xl border border-dark-600 bg-dark-800/60 p-4">
      <h2 className="text-sm font-semibold text-white mb-3">{title} <span className="text-slate-400 font-normal">({issues.length})</span></h2>
      <ul className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
        {issues.map((i, n) => (
          <li key={n} className="flex gap-3 text-sm">
            <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="w-36 shrink-0 whitespace-nowrap text-xs text-slate-400 pt-0.5 font-mono">{i.sheet}{i.row ? ` · row ${i.row}` : ''}</span>
            <span className="text-slate-200">{i.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
