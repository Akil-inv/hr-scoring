'use client';

import { useMemo } from 'react';

/**
 * Capacity readiness planner.
 *
 * Answers "do we have enough judges, and of what kind?" from the data already
 * imported — before anyone spends 120 seconds waiting for the solver to
 * return "infeasible".
 *
 * The arithmetic mirrors the scheduler's hard rules:
 *   - every team is judged once, by a panel of one MD, one ED or SVP, and one PS
 *   - L1 judges are held back for the final round
 *   - vendor judges only see teams using their toolset
 *
 * The binding constraint is usually concurrency, not totals: with 3 rooms
 * running in parallel you need one judge of each kind free in *every* active
 * slot, regardless of how many sessions each does across the event. A pool can
 * have ample total capacity and still be unable to staff a single slot.
 */

export type PlannerJudge = {
  id: string;
  name: string;
  judgeTier?: string | null;
  maxSessions?: number | null;
  vendorToolset?: string | null;
};

export type PlannerTeam = {
  id: string;
  name: string;
  techStack?: string | null;
};

type Props = {
  teams: PlannerTeam[];
  judges: PlannerJudge[];
  roomCount: number;
  slotsPerDay: number;
  eventDays: number;
  minJudgesPerTeam: number;
  /** Hard cap on back-to-back sessions before a break. */
  maxConsecutive?: number;
  /** Tier that anchors a room. */
  anchorTier?: string;
  /** Tiers excluded from the first round. */
  excludedTiers?: string[];
};

const DEFAULT_MAX_SESSIONS = 8;

type Check = {
  label: string;
  detail: string;
  have: number;
  need: number;
  /** ok | warn | fail */
  state: 'ok' | 'warn' | 'fail';
  fix?: string;
};

function isVendor(tier?: string | null) {
  return !!tier && /^V\d/i.test(tier);
}

export default function ReadinessPlanner({
  teams,
  judges,
  roomCount,
  slotsPerDay,
  eventDays,
  minJudgesPerTeam,
  maxConsecutive = 4,
  anchorTier = 'L2',
  excludedTiers = ['L1'],
}: Props) {
  const plan = useMemo(() => {
    const teamCount = teams.length;
    const sessionsNeeded = teamCount;
    const judgeSessionsNeeded = teamCount * minJudgesPerTeam;

    // L1s sit out the first round, so they are not part of this pool.
    const usable = judges.filter((j) => !excludedTiers.includes((j.judgeTier ?? '').toUpperCase()));
    // The panel the scheduler actually builds: one MD, one ED or SVP, one PS.
    // Vendors and leadership are not drawn from — the former are invited to
    // platform blocks by a coordinator, the latter are held for the final round.
    const tierOf = (j: PlannerJudge) => (j.judgeTier ?? '').toUpperCase();
    const mds = usable.filter((j) => tierOf(j) === 'L2');
    const igOthers = usable.filter((j) => ['L3', 'L4'].includes(tierOf(j)));
    const psJudges = judges.filter((j) => tierOf(j) === 'PS');

    const roomSlots = roomCount * slotsPerDay * eventDays;
    const sessionCapacity = (j: PlannerJudge) => j.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const capacityOf = (pool: PlannerJudge[]) =>
      pool.reduce((sum, j) => sum + sessionCapacity(j), 0);
    const totalCapacity = capacityOf(usable);

    const checks: Check[] = [];

    checks.push({
      label: 'Room-slots',
      detail: `${roomCount} rooms × ${slotsPerDay} slots × ${eventDays} days`,
      have: roomSlots,
      need: sessionsNeeded,
      state: roomSlots >= sessionsNeeded * 1.3 ? 'ok' : roomSlots >= sessionsNeeded ? 'warn' : 'fail',
      fix:
        roomSlots < sessionsNeeded
          ? `Add ${Math.ceil((sessionsNeeded - roomSlots) / (slotsPerDay * eventDays))} more room(s)`
          : roomSlots < sessionsNeeded * 1.3
            ? 'Tight. The scheduler has little room to optimise — expect a lower quality score.'
            : undefined,
    });

    // Each pool is checked twice, because two different things go wrong.
    //
    // Concurrency binds first and is invisible in a capacity total: with two
    // rooms running, two MDs are occupied in every slot whatever their session
    // limits say. Capacity is what fails when max_sessions is left at its
    // default.
    const pools: Array<{
      label: string; pool: PlannerJudge[]; detail: string; cover: string;
    }> = [
      { label: 'MDs', pool: mds, detail: 'One per session', cover: 'MD' },
      { label: 'ED / SVP', pool: igOthers, detail: 'One per session', cover: 'ED or SVP' },
      { label: 'Professional Services', pool: psJudges, detail: 'One per session, no cover', cover: 'PS' },
    ];

    for (const { label, pool, detail, cover } of pools) {
      checks.push({
        label: `${label} available at once`,
        detail: `${detail} — every room running needs one free`,
        have: pool.length,
        need: roomCount,
        state:
          pool.length > roomCount ? 'ok' : pool.length === roomCount ? 'warn' : 'fail',
        fix:
          pool.length < roomCount
            ? `Add ${roomCount - pool.length} more ${cover} judge(s) — a room will otherwise sit idle`
            : pool.length === roomCount
              ? 'No spare. One unavailable half-day and the schedule will not fill.'
              : undefined,
      });

      const capacity = capacityOf(pool);
      checks.push({
        label: `${label} session capacity`,
        detail: `Combined max sessions across ${pool.length} judge(s)`,
        have: capacity,
        need: sessionsNeeded,
        state:
          capacity >= sessionsNeeded * 1.15 ? 'ok' : capacity >= sessionsNeeded ? 'warn' : 'fail',
        fix:
          capacity < sessionsNeeded
            ? `Short by ${sessionsNeeded - capacity}. Raise max sessions to at least ` +
              `${Math.ceil(sessionsNeeded / Math.max(pool.length, 1))} each, or add judges.`
            : undefined,
      });
    }

    checks.push({
      label: 'Total judge-sessions',
      detail: `${teamCount} teams × ${minJudgesPerTeam} judges`,
      have: totalCapacity,
      need: judgeSessionsNeeded,
      state:
        totalCapacity >= judgeSessionsNeeded * 1.15
          ? 'ok'
          : totalCapacity >= judgeSessionsNeeded
            ? 'warn'
            : 'fail',
      fix:
        totalCapacity < judgeSessionsNeeded
          ? `Short by ${judgeSessionsNeeded - totalCapacity} judge-sessions`
          : undefined,
    });

    // ── Vendor coverage ──
    // A vendor judge only sees teams using their toolset, so their usable
    // workload is capped by how many such teams exist.
    const vendors = usable.filter((j) => isVendor(j.judgeTier) || j.vendorToolset);
    const toolsetRows = new Map<string, { vendors: number; teams: number; capacity: number }>();

    for (const v of vendors) {
      const ts = (v.vendorToolset ?? 'Unassigned').trim();
      const row = toolsetRows.get(ts) ?? { vendors: 0, teams: 0, capacity: 0 };
      row.vendors += 1;
      row.capacity += sessionCapacity(v);
      toolsetRows.set(ts, row);
    }

    for (const [ts, row] of toolsetRows) {
      if (ts === 'Unassigned') continue;
      const needle = ts.toLowerCase();
      row.teams = teams.filter((t) => (t.techStack ?? '').toLowerCase().includes(needle)).length;
    }

    const excludedCount = judges.length - usable.length;

    return {
      teamCount,
      sessionsNeeded,
      judgeSessionsNeeded,
      roomSlots,
      anchors: mds.length,
      anchorsNeeded: roomCount,
      nonAnchors: igOthers.length,
      usable: usable.length,
      excludedCount,
      checks,
      toolsetRows: [...toolsetRows.entries()],
      ready: checks.every((c) => c.state !== 'fail'),
      warnings: checks.filter((c) => c.state === 'warn').length,
    };
  }, [
    teams,
    judges,
    roomCount,
    slotsPerDay,
    eventDays,
    minJudgesPerTeam,
    maxConsecutive,
    anchorTier,
    excludedTiers,
  ]);

  if (plan.teamCount === 0 || plan.usable === 0) {
    return (
      <div className="rounded-xl border border-dark-600 bg-dark-800/50 p-5">
        <p className="text-sm text-slate-400">
          Import teams and judges to see whether you have the capacity to schedule.
        </p>
      </div>
    );
  }

  const tone = {
    ok: 'text-emerald-300',
    warn: 'text-amber-300',
    fail: 'text-red-300',
  };
  const mark = { ok: '✓', warn: '!', fail: '✕' };

  return (
    <div className="rounded-xl border border-dark-600 bg-dark-800/50 p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Capacity check</h3>
          <p className="mt-1 text-xs text-slate-400">
            {plan.teamCount} teams · {plan.sessionsNeeded} sessions · {plan.judgeSessionsNeeded}{' '}
            judge-sessions
            {plan.excludedCount > 0 && ` · ${plan.excludedCount} judge(s) held back for the final round`}
          </p>
        </div>
        <span
          className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ring-1 ${
            plan.ready
              ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-400/20'
              : 'bg-red-500/10 text-red-300 ring-red-400/20'
          }`}
        >
          {plan.ready ? (plan.warnings > 0 ? 'Tight' : 'Ready') : 'Short'}
        </span>
      </div>

      <div className="space-y-2">
        {plan.checks.map((c) => (
          <div key={c.label} className="rounded-lg bg-dark-900/40 px-4 py-3">
            <div className="flex items-baseline justify-between gap-4">
              <div className="min-w-0">
                <span className={`mr-2 text-xs ${tone[c.state]}`}>{mark[c.state]}</span>
                <span className="text-sm text-white">{c.label}</span>
                <span className="ml-2 text-xs text-slate-500">{c.detail}</span>
              </div>
              <span className={`shrink-0 font-mono text-sm ${tone[c.state]}`}>
                {c.have} / {c.need}
              </span>
            </div>
            {c.fix && <p className={`mt-1.5 pl-6 text-xs ${tone[c.state]}`}>{c.fix}</p>}
          </div>
        ))}
      </div>

      {plan.toolsetRows.length > 0 && (
        <div className="mt-5 border-t border-dark-600 pt-4">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-400">
            Vendor coverage
          </h4>
          <div className="space-y-1.5">
            {plan.toolsetRows.map(([ts, row]) => {
              const sessionsFor = row.teams;
              const over = row.capacity > sessionsFor;
              return (
                <div key={ts} className="flex items-baseline justify-between text-xs">
                  <span className="text-slate-300">{ts}</span>
                  <span className="text-slate-500">
                    {row.vendors} judge(s) · {sessionsFor} matching team(s)
                    {over && sessionsFor > 0 && ' · under-used'}
                    {sessionsFor === 0 && ts !== 'Unassigned' && ' · no matching teams'}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Vendor judges only see teams using their toolset, so they will do fewer sessions than
            other judges. That is expected and not a scheduling fault.
          </p>
        </div>
      )}

      <p className="mt-4 text-[11px] text-slate-500">
        These are the scheduler&apos;s own rules applied as arithmetic. Passing here does not
        guarantee a schedule — narrow availability windows and conflicts can still bind — but
        failing here means no schedule is possible.
      </p>
    </div>
  );
}
