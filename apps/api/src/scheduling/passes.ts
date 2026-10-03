/**
 * Guided scheduling passes.
 *
 * Auto mode hands all 65 teams to the solver at once and lets it optimise
 * globally. Guided mode instead runs a sequence of smaller solves, each
 * locking the previous result, so the constraints that matter operationally
 * are honoured in priority order rather than traded against each other.
 *
 * The order is deliberate:
 *
 *   1. Remote teams. Everything outside SG presents by video, so those teams
 *      can only go in a room with the equipment. This is a hard requirement,
 *      not a preference, and it takes the scarcest resource first.
 *
 *   2. Platform clusters, largest first. Teams sharing a platform are grouped
 *      into contiguous runs so a vendor attending half a day sees a coherent
 *      block rather than three sessions scattered across two days. Largest
 *      first because a big cluster is harder to place once the calendar is
 *      fragmented.
 *
 *   3. Everything else — Internal use cases and anything left over.
 *
 * Each pass is an ordinary solve with the previous passes locked, which is
 * machinery that already exists for working around manual placements.
 *
 * The trade-off is greedy allocation: pass 1 takes the best slots and later
 * passes get what remains. With 72 room-slots for 65 teams there is enough
 * slack that this rarely bites, and the benefit is that a failure names the
 * rule that caused it rather than reporting "infeasible" for a 65-team model.
 */

export type PassTeam = {
  id: string;
  name: string;
  country?: string | null;
  platform?: string | null;
  trackId?: string | null;
};

export type SchedulingPass = {
  /** Shown in warnings and progress, so a failure names the rule. */
  label: string;
  teams: PassTeam[];
  /** Room ids this pass may use. Empty means any room. */
  restrictToRoomIds: string[];
  /** Prefer placing these teams in adjacent slots. */
  cluster: boolean;
};

export type PassPlan = {
  passes: SchedulingPass[];
  warnings: string[];
};

/** Teams outside Singapore present by video and need a VC-capable room. */
const HOME_COUNTRY = 'SG';

/**
 * Hours behind Singapore. Countries sharing the offset are scheduled first,
 * so that by the time the ones an hour behind start, their local clock has
 * caught up — running MY, HK and CN through the morning puts TH, ID and VN
 * comfortably past 09:00 local without needing a rule about it.
 *
 * Indonesia spans three zones; Jakarta is the assumption.
 */
const HOURS_BEHIND_SG: Record<string, number> = {
  MY: 0, HK: 0, CN: 0,
  TH: 1, VN: 1, ID: 1,
};

const COUNTRY_NAMES: Record<string, string> = {
  TH: 'Thailand', MY: 'Malaysia', ID: 'Indonesia',
  VN: 'Vietnam', HK: 'Hong Kong', CN: 'China',
};

/** No external platform, so no vendor is involved and no clustering is useful. */
const NO_VENDOR_PLATFORMS = ['INTERNAL', 'OTHER'];

export function planPasses(
  teams: PassTeam[],
  rooms: Array<{ id: string; name: string; hasVideoConferencing: boolean }>,
  slotsPerRoom: number,
): PassPlan {
  const passes: SchedulingPass[] = [];
  const warnings: string[] = [];

  const vcRooms = rooms.filter((r) => r.hasVideoConferencing);
  const remote = teams.filter(
    (t) => t.country && t.country.toUpperCase() !== HOME_COUNTRY,
  );

  // ── Pass 1: remote teams into VC rooms ──
  if (remote.length > 0) {
    if (vcRooms.length === 0) {
      // Deliberately not fatal. One impossible rule should not block the other
      // 40 teams — the run continues and the coordinator is told plainly.
      warnings.push(
        `${remote.length} team(s) present by video but no room has video conferencing. ` +
        'They will be placed in ordinary rooms — tick the VC box on at least one room.',
      );
    } else {
      const capacity = vcRooms.length * slotsPerRoom;
      if (remote.length > capacity) {
        warnings.push(
          `${remote.length} remote team(s) but only ${capacity} slot(s) across ` +
          `${vcRooms.length} VC room(s). ${remote.length - capacity} will be placed elsewhere.`,
        );
      }

      // One pass per country. Someone in the room hosts the call bridge, and
      // switching between country groups means switching bridges — so each
      // country runs as a contiguous block.
      const byCountry = new Map<string, PassTeam[]>();
      for (const t of remote) {
        const c = (t.country ?? '').toUpperCase();
        const list = byCountry.get(c) ?? [];
        list.push(t);
        byCountry.set(c, list);
      }

      const ordered = [...byCountry.entries()].sort((a, b) => {
        // Same-offset countries first, then those an hour behind.
        const offsetDiff = (HOURS_BEHIND_SG[a[0]] ?? 0) - (HOURS_BEHIND_SG[b[0]] ?? 0);
        if (offsetDiff !== 0) return offsetDiff;
        // Then largest first — a bigger group fills more of the early morning.
        return b[1].length - a[1].length;
      });

      for (const [code, list] of ordered) {
        const name = COUNTRY_NAMES[code] ?? code;
        passes.push({
          label: `${name} (${list.length}) by video`,
          teams: list,
          restrictToRoomIds: vcRooms.map((r) => r.id),
          cluster: true,
        });
      }
    }
  }

  // ── Pass 2: platform clusters ──
  const placed = new Set(passes.flatMap((p) => p.teams.map((t) => t.id)));

  const byPlatform = new Map<string, PassTeam[]>();
  for (const t of teams) {
    if (placed.has(t.id)) continue;
    const p = (t.platform ?? '').toUpperCase();
    if (!p || NO_VENDOR_PLATFORMS.includes(p)) continue;
    const list = byPlatform.get(p) ?? [];
    list.push(t);
    byPlatform.set(p, list);
  }

  // Largest first: a big cluster is harder to place once the calendar is
  // fragmented by smaller ones.
  const platforms = [...byPlatform.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [platform, list] of platforms) {
    passes.push({
      label: `${platform} cluster (${list.length})`,
      teams: list,
      restrictToRoomIds: [],
      cluster: true,
    });

    if (list.length < 4) {
      warnings.push(
        `${platform} has only ${list.length} use case(s). A vendor for this platform ` +
        'will have a short block.',
      );
    }
  }

  // ── Pass 3: everything else ──
  for (const p of passes) for (const t of p.teams) placed.add(t.id);
  const rest = teams.filter((t) => !placed.has(t.id));

  if (rest.length > 0) {
    passes.push({
      label: `Remaining teams (${rest.length})`,
      teams: rest,
      restrictToRoomIds: [],
      cluster: false,
    });
  }

  return { passes, warnings };
}

/**
 * A one-line summary of the plan, for the warnings list.
 *
 * A coordinator pressing generate should be able to see what the scheduler is
 * about to do before it takes two minutes doing it.
 */
export function describePlan(plan: PassPlan): string {
  if (plan.passes.length === 0) return 'No teams to schedule.';
  return `Guided: ${plan.passes.map((p) => p.label).join(' → ')}`;
}
