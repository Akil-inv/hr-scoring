'use client';

import CountryFlag from '@/components/country-flag';

/**
 * What the team is actually presenting.
 *
 * A judge scoring twelve criteria needs to re-read the problem statement
 * halfway through more often than the layout admits — and abandoning a
 * half-filled scorecard to go and find it is not a reasonable ask. So this is
 * a layer rather than a page: it opens over whatever is beneath, and closing
 * puts the judge back exactly where they were with their entries intact.
 *
 * Deliberately plain. This is the one screen a judge reads rather than scans,
 * so it is set at reading width with generous line height and nothing
 * competing for attention.
 */

type UseCase = {
  teamName: string;
  projectName?: string | null;
  useCaseTitle?: string | null;
  problemStatement?: string | null;
  solutionSummary?: string | null;
  techStack?: string | null;
  country?: string | null;
  track?: string | null;
  organisation?: string | null;
  room?: string | null;
  startTime?: string | null;
};

export default function UseCasePanel({
  data,
  onClose,
}: {
  data: UseCase;
  onClose: () => void;
}) {
  const when = data.startTime
    ? new Date(data.startTime).toLocaleString('en-SG', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : null;

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-[#f4f6fa]">
      {/* The close control stays put while the content scrolls — on a long
          problem statement it is otherwise stranded at the top. */}
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur px-4 py-3.5 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-xl font-semibold text-slate-900 sm:text-2xl">
                {data.teamName}
              </h2>
              <CountryFlag code={data.country} size={18} />
            </div>
            {when && <p className="text-sm text-slate-500">{when}{data.room ? ` · ${data.room}` : ''}</p>}
          </div>
          <button type="button"
            onClick={onClose}
            className="shrink-0 rounded-xl bg-slate-900 px-5 py-2.5 text-base font-medium text-white hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        {(data.track || data.organisation || data.techStack) && (
          <div className="mb-6 flex flex-wrap gap-2">
            {data.track && (
              <span className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700">
                {data.track}
              </span>
            )}
            {data.organisation && (
              <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-600">
                {data.organisation}
              </span>
            )}
            {data.techStack && (
              <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-600">
                {data.techStack}
              </span>
            )}
          </div>
        )}

        {data.useCaseTitle && (
          <div className="mb-7">
            <p className="mb-1.5 text-sm font-medium uppercase tracking-wider text-slate-500">
              Use case
            </p>
            <p className="text-2xl font-semibold leading-snug text-slate-900 sm:text-3xl">
              {data.useCaseTitle}
            </p>
          </div>
        )}

        {data.problemStatement ? (
          <div className="mb-7">
            <p className="mb-2 text-sm font-medium uppercase tracking-wider text-slate-500">
              The problem
            </p>
            <p className="text-lg leading-relaxed text-slate-800">{data.problemStatement}</p>
          </div>
        ) : null}

        {data.solutionSummary ? (
          <div className="mb-7">
            <p className="mb-2 text-sm font-medium uppercase tracking-wider text-slate-500">
              Their solution
            </p>
            <p className="text-lg leading-relaxed text-slate-800">{data.solutionSummary}</p>
          </div>
        ) : null}

        {!data.problemStatement && !data.solutionSummary && (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <p className="text-base text-slate-500">
              This team has not recorded a problem statement or solution summary.
              You will hear it from them in the room.
            </p>
          </div>
        )}

        {data.projectName && data.projectName !== data.teamName && (
          <p className="mt-8 border-t border-slate-200 pt-5 text-base text-slate-500">
            Project: {data.projectName}
          </p>
        )}
      </div>
    </div>
  );
}
