'use client';

import { useMemo, useState } from 'react';
import CountryFlag from '@/components/country-flag';
import DriftMetronome from '@/components/drift-metronome';

/**
 * The judge's day as four counts, framed by two ribbons.
 *
 * Light, and deliberately so. The judges are MDs and EDs reading between
 * presentations, often on a phone, often at arm's length — a dark theme with
 * 11px labels is the wrong tool for that audience. Everything here is at least
 * 14px, team names are 20px, and the page is near-white.
 *
 * The cards are finished like anodised metal: a pale diagonal sheen with a
 * brighter band through the middle and a soft shadow beneath, so each sits
 * above the page rather than being drawn on it. Metal reads as metal on a
 * light ground; on black the same gradients read as a glow.
 *
 * Colour carries meaning rather than decoration. Amber is the only warm card,
 * so outstanding work is the one thing that draws the eye across the room.
 * Everything else is cool: steel for what is coming, lilac for what is done,
 * sea green for what was set aside.
 *
 * Nothing scrolls. Tapping a quadrant expands it into the space the grid
 * occupied, so the page height never changes, and a quadrant holding more than
 * fits pages rather than growing.
 */

type Session = {
  sessionId: string;
  /** This judge has stepped out of this session. */
  onBreak?: boolean;
  team: { name: string; projectName?: string; country?: string | null; platform?: string | null };
  room: string;
  date: string;
  startTime: string;
  endTime: string;
  stage: string;
};

type Scorecard = {
  sessionId: string;
  status: string;
  totalScore?: number | null;
  flaggedForReview?: boolean;
};

const SUBMITTED = ['SUBMITTED', 'RESUBMITTED', 'LOCKED'];

/**
 * What a judge is being asked for.
 *
 * "not started" is wrong for a reopened scorecard — the judge did the work and
 * a coordinator has asked them to look at it again. Calling that "not started"
 * suggests the earlier score was lost.
 */
function statusLabel(status?: string): string {
  if (status === 'REOPENED') return 'reopened for revision';
  if (status === 'DRAFT') return 'half scored';
  return 'not started';
}
const PAGE_SIZE = 3;

/**
 * Times are shown in the event's timezone, not the judge's device.
 *
 * A judge dialling in from Bangkok reading "14:00" needs it to mean the same
 * thing the coordinator means. Showing them their own local time against a
 * schedule written in event time is how somebody misses a session.
 */
const EVENT_TZ = 'Asia/Singapore';

const timeOf = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString('en-SG', {
    timeZone: EVENT_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }) : '';

const dayOf = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString('en-SG', {
    timeZone: EVENT_TZ, weekday: 'short', day: 'numeric', month: 'short',
  }) : '';

type Panel = 'needs' | 'next' | 'done' | 'revisit' | null;

/**
 * Anodised metal, lit from above.
 *
 * `sheen` is the diagonal gradient — dark corner, bright band through the
 * middle, dark corner again. `ring` is the border, brighter along the top edge
 * where the light lands. `glow` is the shadow the card casts, tinted so it
 * reads as coloured light rather than grey.
 */
/**
 * Anodised plate, lit from the top left.
 *
 * `sheen` runs bottom-right to top-left — darkest in the far corner, brightest
 * where the light falls. Broad stops rather than a narrow band, so the middle
 * of the card stays calm and the metal reads as a surface rather than a stripe.
 *
 * `bevel` is four shadows doing one job. An inset highlight along the top edge
 * and an inset shade along the bottom give the rim its depth; a tight outer
 * ring in the card's own colour draws the edge; a wider diffuse glow lifts the
 * whole plate off the page. Together they read as a bevelled panel rather than
 * a rectangle with a border.
 */
const FINISH = {
  needs: {
    sheen: 'linear-gradient(315deg,#cdb181 0%,#e3cfa6 22%,#f4e6c8 48%,#fbf3e2 72%,#fefbf4 100%)',
    bevel: [
      'inset 0 1.5px 0 rgba(255,252,242,0.9)',
      'inset 0 -1.5px 0 rgba(150,112,40,0.28)',
      '0 0 0 1px rgba(186,146,66,0.5)',
      '0 10px 28px -10px rgba(150,112,40,0.42)',
    ].join(','),
    ink: '#6b4c14', dim: '#8a6a2c', chip: 'rgba(255,252,244,0.7)',
    edge: 'rgba(186,146,66,0.4)',
  },
  next: {
    sheen: 'linear-gradient(315deg,#a9bdd3 0%,#c6d6e6 22%,#dfeaf5 48%,#eff5fb 72%,#f9fcff 100%)',
    bevel: [
      'inset 0 1.5px 0 rgba(252,254,255,0.95)',
      'inset 0 -1.5px 0 rgba(70,105,145,0.26)',
      '0 0 0 1px rgba(112,148,188,0.48)',
      '0 10px 28px -10px rgba(70,105,145,0.4)',
    ].join(','),
    ink: '#1e4468', dim: '#436184', chip: 'rgba(250,253,255,0.75)',
    edge: 'rgba(112,148,188,0.38)',
  },
  done: {
    sheen: 'linear-gradient(315deg,#bcaed3 0%,#d3c9e5 22%,#e7e0f2 48%,#f3effa 72%,#fbf9fe 100%)',
    bevel: [
      'inset 0 1.5px 0 rgba(253,251,255,0.95)',
      'inset 0 -1.5px 0 rgba(95,75,140,0.24)',
      '0 0 0 1px rgba(140,120,182,0.45)',
      '0 10px 28px -10px rgba(95,75,140,0.38)',
    ].join(','),
    ink: '#43306b', dim: '#63508a', chip: 'rgba(252,250,255,0.75)',
    edge: 'rgba(140,120,182,0.36)',
  },
  revisit: {
    sheen: 'linear-gradient(315deg,#9fc2bb 0%,#bdd7d1 22%,#d8e9e5 48%,#ecf5f3 72%,#f7fcfb 100%)',
    bevel: [
      'inset 0 1.5px 0 rgba(250,255,254,0.95)',
      'inset 0 -1.5px 0 rgba(50,110,100,0.24)',
      '0 0 0 1px rgba(96,156,146,0.45)',
      '0 10px 28px -10px rgba(50,110,100,0.38)',
    ].join(','),
    ink: '#155048', dim: '#376b62', chip: 'rgba(248,254,253,0.75)',
    edge: 'rgba(96,156,146,0.36)',
  },
} as const;

export default function QuadrantView({
  sessions,
  scorecards,
  onScore,
  onInfo,
  onBreak,
  footer,
}: {
  sessions: Session[];
  scorecards: Scorecard[];
  /** Opens a scorecard. `queue` carries the remaining outstanding session ids. */
  onScore: (sessionId: string, queue?: string[]) => void;
  /** Opens the use case panel for a session. */
  onInfo?: (sessionId: string) => void;
  /** Declares or clears a break. Only passed for an MD. */
  onBreak?: (sessionId: string, onBreak: boolean) => void;
  footer?: React.ReactNode;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [page, setPage] = useState(0);
  const open = (p: Panel) => { setPanel(p); setPage(0); };

  const g = useMemo(() => {
    const now = Date.now();
    const card = (id: string) => scorecards.find(c => c.sessionId === id);
    const rows = sessions.map(s => ({ s, c: card(s.sessionId) }));

    const flagged = ({ c }: (typeof rows)[number]) => !!c?.flaggedForReview;
    const submitted = ({ c }: (typeof rows)[number]) =>
      SUBMITTED.includes(c?.status ?? '');

    /**
     * A session the judge has stepped out of is not theirs.
     *
     * `on_break` was recorded correctly and read nowhere: the ribbon kept
     * offering "Score now" for a team the judge had just excused themselves
     * from, and pressing it opened a scorecard the portal will not serve —
     * /scorecards excludes sessions on break. A confusing screen became an
     * error one press later.
     */
    const steppedOut = ({ s }: (typeof rows)[number]) => !!s.onBreak;

    /** A flag reparents work still owed; a submitted card stays in DONE. */
    const flaggedUnsubmitted = (r: (typeof rows)[number]) =>
      flagged(r) && !submitted(r);


    // Live is the session the organiser started, not the one the clock says
    // should be running. On a day that slips, the clock is the wrong authority.
    //
    // A reopened scorecard is excluded. A coordinator reopening one does not
    // change the session's stage, so a session still marked SCORING would
    // otherwise present as "Score now" — as though the team were in the room —
    // when what is actually being asked for is a correction to work already
    // done. The judge needs it in AWAITING YOU, with the rest of their
    // outstanding work.
    const live = rows.find(
      (r) =>
        ['IN_PROGRESS', 'SCORING'].includes(r.s.stage) &&
        r.c?.status !== 'REOPENED' &&
        !flaggedUnsubmitted(r) &&
        !steppedOut(r),
    );

    /**
     * A flag takes a card out of every other list.
     *
     * The two boxes answer different questions. AWAITING YOU is "what have I
     * not dealt with"; REVISIT is "what did I deliberately park to come back
     * to". A judge who scores half a team and flags it has dealt with it — they
     * have made a decision to return, which is not the same as having
     * forgotten. Showing it in both blurs the distinction the boxes exist to
     * draw, and a judge working through AWAITING YOU would keep meeting a card
     * they had already set aside.
     *
     * Clearing the flag puts it back wherever it belongs, so nothing can be
     * parked and then lost.
     */

    // Outstanding work from any day, oldest first — the one furthest back is
    // the one most at risk of being forgotten.
    //
    // Reopened scorecards belong here whatever stage their session is in: the
    // session may have finished days ago, or may never have been moved past
    // SCORING. Either way the judge owes a score.
    const needs = rows
      .filter((r) => !flaggedUnsubmitted(r) && !steppedOut(r))
      .filter(({ s, c }) =>
        c?.status === 'REOPENED' ||
        (s.stage === 'COMPLETED' && !SUBMITTED.includes(c?.status ?? 'NOT_STARTED')),
      )
      .sort((a, b) => (a.s.startTime || '').localeCompare(b.s.startTime || ''));

    const next = rows
      .filter((r) => !flaggedUnsubmitted(r) && !steppedOut(r))
      .filter(({ s }) => s.stage === 'SCHEDULED' && new Date(s.startTime).getTime() > now - 3600_000)
      .sort((a, b) => (a.s.startTime || '').localeCompare(b.s.startTime || ''));

    // DONE stays a record of what was submitted, flagged or not: a judge asking
    // "how many have I finished" is asking about work, not about bookmarks.
    // The progress bar reads from here.
    const done = rows.filter(submitted);
    // Only work still owed. A flag on a submitted scorecard is a note to
    // nobody: the judge cannot change it without a coordinator reopening it,
    // and it belongs in DONE with the rest of their finished work.
    const revisit = rows.filter((r) => flagged(r) && !submitted(r));

    const scores = done.map(({ c }) => c?.totalScore ?? 0).filter(n => n > 0);
    return {
      live, needs, next, done, revisit,
      avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      lo: scores.length ? Math.min(...scores) : null,
      hi: scores.length ? Math.max(...scores) : null,
      last: done.length ? done[done.length - 1] : null,
    };
  }, [sessions, scorecards]);

  /** Hand the whole outstanding queue over, so finishing one leads to the next. */
  const startQueue = (from: number) => {
    const queue = g.needs.map(({ s }) => s.sessionId);
    if (queue.length) onScore(queue[from], queue.slice(from + 1));
  };

  const slice = (items: any[]) => items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  // No border. The rim is drawn entirely by the shadow stack, which is what
  // lets it be brighter on top than underneath.
  const cardStyle = (f: typeof FINISH.needs): React.CSSProperties => ({
    background: f.sheen,
    boxShadow: f.bevel,
  });

  const ICON = { needs: '!', next: '→', done: '✓', revisit: '⚑' } as const;

  /**
   * Two layouts, one component.
   *
   * On a phone the tile is a square carrying only what can be read at a
   * glance: icon, label, count. Everything else — the subtitle, the preview
   * rows, the footer link — is hidden, because none of it is actionable from
   * the tile and all of it is one tap away. That is what lets four tiles, the
   * ribbon and the progress bar share a phone screen without scrolling.
   *
   * From 640px up the fuller tile returns.
   */
  const Tile = ({
    kind, title, subtitle, count, unit, cta, children,
  }: {
    kind: keyof typeof FINISH;
    title: string; subtitle: string; count: number; unit: string; cta: string;
    children?: React.ReactNode;
  }) => {
    const f = FINISH[kind];
    return (
      <button type="button"
        onClick={() => open(kind)}
        style={cardStyle(f)}
        className="group flex h-full flex-col rounded-2xl p-3.5 sm:p-5 min-h-[122px] sm:min-h-[212px] text-left w-full transition-transform duration-200 hover:-translate-y-1"
      >
        {/* Phone: icon on its own row, then label and count beneath. */}
        <div className="flex sm:hidden flex-col h-full">
          <div className="flex items-start justify-between">
            <span
              style={{ background: f.chip, border: `1px solid ${f.edge}` }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            >
              <span style={{ color: f.ink }} className="text-sm">{ICON[kind]}</span>
            </span>
            <p style={{ color: f.ink }} className="text-3xl font-semibold leading-none tabular-nums">{count}</p>
          </div>

          <p style={{ color: f.ink }} className="mt-2.5 text-[11px] font-semibold tracking-[0.06em] whitespace-nowrap">
            {title}
          </p>

          {/* With room on the tile again, a line of detail saves a tap for the
              question a judge asks most: what is it, and when. */}
          <div className="mt-1 overflow-hidden">{children}</div>
        </div>

        {/* Desktop: the full card. */}
        <div className="hidden sm:flex sm:flex-col sm:h-full">
          <div className="flex items-start gap-3.5">
            <span
              style={{ background: f.chip, border: `1px solid ${f.edge}` }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            >
              <span style={{ color: f.ink }} className="text-lg">{ICON[kind]}</span>
            </span>
            <div className="flex-1 min-w-0">
              <p style={{ color: f.ink }} className="text-base font-semibold tracking-wide whitespace-nowrap">{title}</p>
              <p style={{ color: f.dim }} className="text-sm truncate">{subtitle}</p>
            </div>
            <div className="text-right shrink-0 pl-2">
              <p style={{ color: f.ink }} className="text-4xl font-semibold leading-none tabular-nums">{count}</p>
              <p style={{ color: f.dim }} className="text-xs mt-1 whitespace-nowrap">{unit}</p>
            </div>
          </div>

          <div className="flex-1 pt-4">{children}</div>

          <div
            style={{ borderTop: `1px solid ${f.edge}` }}
            className="flex items-center justify-between pt-3 mt-1"
          >
            <span style={{ color: f.ink }} className="text-sm font-medium">{cta}</span>
            <span style={{ color: f.dim }} className="text-lg transition-transform group-hover:translate-x-0.5">›</span>
          </div>
        </div>
      </button>
    );
  };

  const Pager = ({ items }: { items: any[] }) => {
    const pages = Math.ceil(items.length / PAGE_SIZE);
    if (pages <= 1) return null;
    return (
      <div className="flex items-center gap-3 mt-4">
        <button type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 disabled:opacity-40">
          Back
        </button>
        <span className="text-sm text-slate-500">{page + 1} of {pages}</span>
        <button type="button" onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 disabled:opacity-40">
          Next
        </button>
      </div>
    );
  };

  const row = 'flex items-center gap-3 sm:gap-4 rounded-xl border border-white/70 bg-white/70 px-3.5 sm:px-4 py-3.5 mb-2.5';
  const panelFinish = panel ? FINISH[panel] : FINISH.next;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* ── Ribbon: what is happening now ── */}
      {g.live ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-5 shadow-sm">
          <div className="flex items-center gap-2.5 mb-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-sm font-medium text-emerald-700">Now</span>
            <span className="ml-auto text-sm text-slate-500">{g.live.s.room}</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-lg sm:text-2xl font-semibold text-slate-900 truncate">{g.live.s.team.name}</p>
                <CountryFlag code={g.live.s.team.country} size={18} />
                {onInfo && (
                  <button type="button"
                    onClick={(e) => { e.stopPropagation(); onInfo(g.live!.s.sessionId); }}
                    title="What is this team presenting?"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-300 text-sm font-serif italic text-slate-600 hover:border-slate-400 hover:text-slate-900"
                  >i</button>
                )}
              </div>
              {/* The project name is context a judge already has in the room. */}
              <p className="hidden sm:block text-base text-slate-600 truncate mt-0.5">{g.live.s.team.projectName}</p>
            </div>
            <button type="button"
              onClick={() => onScore(g.live!.s.sessionId)}
              className="shrink-0 rounded-xl bg-slate-900 px-5 sm:px-7 py-2.5 sm:py-3.5 text-base font-medium text-white hover:bg-slate-800"
            >
              <span className="sm:hidden">Score</span>
              <span className="hidden sm:inline">Score now</span>
            </button>
            {/* Only an MD sees this, because only an MD may. A control that
                appears and then fails is worse than one that is absent. */}
            {onBreak && (
              <button type="button"
                onClick={() => onBreak(g.live!.s.sessionId, true)}
                className="shrink-0 rounded-xl border border-slate-300 bg-white px-4 py-2.5 sm:py-3.5 text-base text-slate-600 hover:text-slate-900"
              >Step out</button>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 shadow-sm">
          <p className="text-base text-slate-600">
            {sessions.some(s => s.onBreak) && (
              <span className="mr-2 rounded-lg bg-slate-200 px-2.5 py-1 text-sm text-slate-700">
                You stepped out of {sessions.filter(s => s.onBreak).length} session(s)
              </span>
            )}
            {(() => {
              // Flagged work is set aside, not finished. Saying "all caught up"
              // over the top of it is how a parked scorecard gets forgotten.
              // revisit holds only work still owed, so its length is the count.
              const parked = g.revisit.length;

              const nextBit = g.next.length > 0 ? (
                <>Next session:{' '}
                  <span className="font-semibold text-slate-900">{g.next[0].s.team.name}</span>
                  {' '}at {timeOf(g.next[0].s.startTime)}</>
              ) : null;

              if (parked > 0) {
                return (
                  <>
                    <span className="font-semibold text-slate-900">
                      {parked} team{parked > 1 ? 's' : ''} set aside for a second look.
                    </span>
                    {nextBit ? <> {nextBit}</> : null}
                  </>
                );
              }
              return g.next.length > 0
                ? <>You&rsquo;re all caught up. {nextBit}</>
                : 'Nothing running.';
            })()}
          </p>
        </div>
      )}

      {/* ── The grid, or one quadrant expanded into the same space ── */}
      <div className="flex flex-1 flex-col py-3 min-h-0 sm:py-4">
        {panel === null ? (
          <div className="grid flex-1 grid-cols-2 gap-2.5 auto-rows-fr sm:gap-4">
            <Tile kind="needs" title="AWAITING YOU" subtitle="Awaiting your submission"
              count={g.needs.length} unit="teams" cta="View all">
              {g.needs.slice(0, 2).map(({ s, c }) => (
                <p key={s.sessionId} style={{ color: FINISH.needs.dim }} className="text-xs sm:text-[15px] truncate">
                  {s.team.name}
                  <span className="hidden sm:inline"> · {statusLabel(c?.status)}</span>
                </p>
              ))}
            </Tile>

            <Tile kind="next" title="UP NEXT" subtitle="Your upcoming sessions"
              count={g.next.length} unit="remaining" cta="Open next session">
              {g.next.slice(0, 2).map(({ s }) => (
                <div key={s.sessionId} className="flex items-center gap-2 sm:gap-3 mb-0.5 sm:mb-1.5">
                  <span style={{ color: FINISH.next.dim }} className="font-mono text-xs sm:text-[15px]">{timeOf(s.startTime)}</span>
                  <span style={{ color: FINISH.next.ink }} className="text-xs sm:text-[15px] font-medium truncate">{s.team.name}</span>
                  <CountryFlag code={s.team.country} size={13} />
                </div>
              ))}
            </Tile>

            <Tile kind="done" title="DONE" subtitle="Completed scoring"
              count={g.done.length} unit="teams" cta="View history">
              {g.done.length > 0 && (
                <div className="flex items-end justify-between">
                  <div>
                    <p style={{ color: FINISH.done.dim }} className="text-xs sm:text-[15px]">
                      {/*
                        The label was written as "Avg" plus a hidden "erage",
                        so it read "Average" on desktop and "Avg" on a phone.
                        The value landed between the two halves and it rendered
                        "Avg 16erage" — invisible on mobile, where the second
                        half is hidden, which is why it survived.
                      */}
                      <span className="sm:hidden">Avg</span>
                      <span className="hidden sm:inline">Average</span>
                      {' '}{g.avg} · {g.lo}–{g.hi}
                    </p>
                    {g.last && (
                      <p style={{ color: FINISH.done.dim }} className="text-sm truncate mt-0.5">
                        Last: {g.last.s.team.name}, {g.last.c?.totalScore}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 opacity-70">
                    <DriftMetronome scorecards={scorecards} sessions={sessions} />
                  </div>
                </div>
              )}
            </Tile>

            <Tile kind="revisit" title="REVISIT" subtitle="Flagged for review"
              count={g.revisit.length} unit="teams" cta="View flagged">
              {g.revisit.slice(0, 2).map(({ s, c }) => (
                <p key={s.sessionId} style={{ color: FINISH.revisit.dim }} className="text-xs sm:text-[15px] truncate">
                  {s.team.name}
                  <span className="hidden sm:inline"> · {statusLabel(c?.status)}</span>
                </p>
              ))}
            </Tile>
          </div>
        ) : (
          <div style={cardStyle(panelFinish)} className="flex flex-1 flex-col rounded-2xl p-4 sm:p-6 min-h-[380px] sm:min-h-[440px]">
            <div className="flex items-center gap-3 mb-5">
              <p style={{ color: panelFinish.ink }} className="text-base font-semibold tracking-wide">
                {panel === 'needs' ? 'AWAITING YOUR SUBMISSION' : panel === 'next' ? 'UP NEXT' : panel === 'done' ? 'DONE' : 'REVISIT'}
              </p>
              <button type="button" onClick={() => setPanel(null)}
                style={{ color: panelFinish.ink, borderColor: panelFinish.edge }}
                className="ml-auto rounded-lg border bg-white/70 px-3.5 py-1.5 text-sm font-medium">
                Close
              </button>
            </div>

            {panel === 'needs' && (g.needs.length === 0 ? (
              <p className="text-base" style={{ color: panelFinish.dim }}>Nothing outstanding.</p>
            ) : (
              <>
                {slice(g.needs).map(({ s, c }, i) => (
                  <div key={s.sessionId} className={row}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-semibold text-slate-900 truncate">{s.team.name}</span>
                        <CountryFlag code={s.team.country} size={16} />
                      </div>
                      <p className="text-sm text-slate-500 mt-0.5">
                        {dayOf(s.startTime)} · {timeOf(s.startTime)} ·{' '}
                        {statusLabel(c?.status)}
                      </p>
                    </div>
                    <button type="button" onClick={() => startQueue(page * PAGE_SIZE + i)}
                      className="shrink-0 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800">
                      {c?.status === 'REOPENED' ? 'Revise' : c?.status === 'DRAFT' ? 'Finish' : 'Score'}
                    </button>
                  </div>
                ))}
                <Pager items={g.needs} />
                <p className="text-sm mt-4" style={{ color: panelFinish.dim }}>
                  Finishing one takes you straight to the next.
                </p>
              </>
            ))}

            {panel === 'next' && (g.next.length === 0 ? (
              <p className="text-base" style={{ color: panelFinish.dim }}>Nothing left.</p>
            ) : (
              <>
                {slice(g.next).map(({ s }) => (
                  <div key={s.sessionId} className={row}>
                    <span className="font-mono text-base text-slate-500 w-14">{timeOf(s.startTime)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-lg text-slate-900 truncate">{s.team.name}</span>
                        <CountryFlag code={s.team.country} size={16} />
                      </div>
                      <p className="text-sm text-slate-500 mt-0.5">{dayOf(s.startTime)} · {s.room}</p>
                    </div>
                    {onInfo && (
                      <button type="button"
                        onClick={() => onInfo(s.sessionId)}
                        title="What is this team presenting?"
                        className="shrink-0 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
                      >Use case</button>
                    )}
                  </div>
                ))}
                <Pager items={g.next} />
              </>
            ))}

            {panel === 'done' && (g.done.length === 0 ? (
              <p className="text-base" style={{ color: panelFinish.dim }}>Nothing scored yet.</p>
            ) : (
              <>
                {slice(g.done).map(({ s, c }) => (
                  <div key={s.sessionId} className={row}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-lg text-slate-900 truncate">{s.team.name}</span>
                        <CountryFlag code={s.team.country} size={16} />
                      </div>
                      <p className="text-sm text-slate-500 mt-0.5">{dayOf(s.startTime)} · {timeOf(s.startTime)}</p>
                    </div>
                    <span className="shrink-0 font-mono text-xl text-slate-900">{c?.totalScore}</span>
                    <button type="button" onClick={() => onScore(s.sessionId)}
                      className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700">
                      View
                    </button>
                  </div>
                ))}
                <Pager items={g.done} />
              </>
            ))}

            {panel === 'revisit' && (g.revisit.length === 0 ? (
              <p className="text-base" style={{ color: panelFinish.dim }}>Nothing flagged for a second look.</p>
            ) : (
              <>
                {slice(g.revisit).map(({ s }) => (
                  <div key={s.sessionId} className={row}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-lg text-slate-900 truncate">{s.team.name}</span>
                        <CountryFlag code={s.team.country} size={16} />
                      </div>
                      <p className="text-sm text-slate-500 mt-0.5">{dayOf(s.startTime)} · {timeOf(s.startTime)}</p>
                    </div>
                    <button type="button" onClick={() => onScore(s.sessionId)}
                      className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700">
                      Open
                    </button>
                  </div>
                ))}
                <Pager items={g.revisit} />
              </>
            ))}
          </div>
        )}
      </div>

      {/* ── Ribbon: progress now, coordinator messages later ── */}
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 sm:px-6 sm:py-4 shadow-sm">
        {footer ?? (
          <div className="flex items-center gap-3 sm:gap-5">
            <div className="min-w-0">
              <p className="hidden sm:block text-base font-medium text-slate-900">Your progress</p>
              <p className="text-sm text-slate-500 sm:mt-0.5 whitespace-nowrap">
                {g.done.length} of {sessions.length}
                <span className="hidden sm:inline"> scored
                  {g.next.length > 0 && ` · next at ${timeOf(g.next[0].s.startTime)}`}
                </span>
              </p>
            </div>
            <div className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-slate-800 transition-all duration-500"
                style={{ width: `${sessions.length ? (g.done.length / sessions.length) * 100 : 0}%` }}
              />
            </div>
            <span className="text-base font-medium text-slate-700 tabular-nums shrink-0">
              {sessions.length ? Math.round((g.done.length / sessions.length) * 100) : 0}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
