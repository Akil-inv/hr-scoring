/**
 * Anchor allocation.
 *
 * Every session needs two fixed seats — an L2 anchoring the room, and a PS
 * alongside. The third seat rotates from L3 and L4.
 *
 * This is deliberately not solved. With two MDs and two rooms the assignment
 * is clerical: MD1 takes room 1, MD2 takes room 2, both days. There is nothing
 * to optimise. Handing it to CP-SAT would triple the model for no gain, and
 * make the result an emergent property rather than something a coordinator can
 * read off a page.
 *
 * Deciding it here instead shrinks the solver's job to placing teams and
 * choosing one rotating judge per session, which is both faster and easier to
 * explain when it goes wrong.
 *
 * An anchor sits in one room for a whole day. They step out for one slot in
 * every five to avoid fatigue; a spare L2 covers that slot if one exists,
 * otherwise the third seat is filled by an L3 or L4 who anchors for that slot.
 * A floating MD who joins ad hoc is not modelled — the Command Centre adds
 * them to sessions directly.
 */

export type AnchorJudge = {
  id: string;
  name: string;
  judgeTier: string;
  maxSessions: number;
  isStandby: boolean;
};

export type AnchorAssignment = {
  roomId: string;
  roomName: string;
  /** YYYY-MM-DD */
  date: string;
  anchorJudgeId: string | null;
  anchorJudgeName: string | null;
  psJudgeId: string | null;
  psJudgeName: string | null;
  /** Slot ids where the anchor steps out. Covered by the rotating seat. */
  anchorBreakSlotIds: string[];
  /** Set when a room-day could not be given an L2 or a PS. */
  warnings: string[];
};

export type AnchorPlan = {
  assignments: AnchorAssignment[];
  /** Judge ids that must not be used for the rotating seat. */
  reservedJudgeIds: string[];
  /** Slots carrying an extra judge, where the anchor may take a break. */
  coverSlotIds: string[];
  warnings: string[];
};

/** Sessions an anchor covers before stepping out for one. */
const SESSIONS_BEFORE_BREAK = 4;

export function allocateAnchors(
  judges: AnchorJudge[],
  rooms: Array<{ id: string; name: string }>,
  slotsByDate: Map<string, Array<{ id: string }>>,
): AnchorPlan {
  const l2 = judges.filter((j) => j.judgeTier === 'L2');
  const ps = judges.filter((j) => j.judgeTier === 'PS');
  // Vendors are never scheduled. They are additive, and which sessions they
  // attend depends on the platform a use case was built on — a judgement for
  // a coordinator, not the solver.
  const vendors = judges.filter((j) => j.judgeTier === 'V');

  const assignments: AnchorAssignment[] = [];
  const warnings: string[] = [];
  const reserved = new Set<string>();
  // Slots carrying an extra L3 so the anchor may step out.
  const coverSlotIds: string[] = [];

  const dates = [...slotsByDate.keys()].sort((a, b) => String(a).localeCompare(String(b)));

  if (l2.length === 0) {
    warnings.push('No L2 judges. Every session will be anchored by an L3 or L4.');
  } else if (l2.length < rooms.length) {
    warnings.push(
      `${l2.length} L2 judge(s) for ${rooms.length} rooms. ` +
      `${rooms.length - l2.length} room(s) per day will be anchored by an L3 or L4 throughout.`,
    );
  } else if (l2.length === rooms.length) {
    warnings.push(
      `${l2.length} L2 judge(s) for ${rooms.length} rooms — no spare. ` +
      'Breaks will be covered by an L3 or L4, and an absence needs a manual swap.',
    );
  }

  if (ps.length === 0) {
    warnings.push('No PS judges. The second seat will be filled from the rotating pool.');
  } else if (ps.length < rooms.length) {
    warnings.push(
      `${ps.length} PS judge(s) for ${rooms.length} rooms. PS work continuously and do not ` +
      'rotate, so a shortfall here cannot be covered by a break pattern.',
    );
  }

  for (const date of dates) {
    const slots = slotsByDate.get(date) ?? [];

    rooms.forEach((room, roomIndex) => {
      const roomWarnings: string[] = [];

      // Anchors are assigned round-robin by room. With equal counts each room
      // keeps the same anchor all day, which is what "the MD chairs the room"
      // means in practice.
      const anchor = l2[roomIndex] ?? null;
      const psJudge = ps[roomIndex] ?? null;

      if (!anchor) roomWarnings.push('no L2 anchor — an L3 or L4 will anchor this room');
      if (!psJudge) roomWarnings.push('no PS — the second seat comes from the rotating pool');

      // Cover, not a forced break. Every fifth session carries an extra L3 so
      // the anchor *may* step out — four on, one covered, repeating. Three
      // opportunities in a sixteen-slot day. The anchor is still scheduled for
      // the session; whether they use the break is theirs to decide on the
      // day, and the judge portal offers it only where cover exists.
      const breakSlotIds: string[] = [];
      if (anchor) {
        slots.forEach((slot, i) => {
          if (i > 0 && (i + 1) % (SESSIONS_BEFORE_BREAK + 1) === 0) {
            coverSlotIds.push(slot.id);
          }
        });
      }

      if (anchor) reserved.add(anchor.id);
      if (psJudge) reserved.add(psJudge.id);
      // Spare L2 and PS are held back too. A spare MD picked up as a third
      // judge would end up spanning both rooms, which is exactly what
      // anchoring is meant to prevent. They stay free for break cover and for
      // the Command Centre to place.
      for (const j of l2) reserved.add(j.id);
      for (const j of ps) reserved.add(j.id);

      assignments.push({
        roomId: room.id,
        roomName: room.name,
        date,
        anchorJudgeId: anchor?.id ?? null,
        anchorJudgeName: anchor?.name ?? null,
        psJudgeId: psJudge?.id ?? null,
        psJudgeName: psJudge?.name ?? null,
        anchorBreakSlotIds: breakSlotIds,
        warnings: roomWarnings,
      });
    });
  }

  for (const v of vendors) reserved.add(v.id);

  if (vendors.length > 0) {
    warnings.push(
      `${vendors.length} vendor judge(s) held back. Invite them to sessions from the ` +
      'Command Centre once the platform clusters are visible.',
    );
  }

  return {
    assignments,
    reservedJudgeIds: [...reserved],
    coverSlotIds,
    warnings,
  };
}

/**
 * Sessions each anchor is expected to cover, for the capacity check.
 *
 * An anchor working four slots in five across a two day event does more
 * sessions than a rotating judge, so their maxSessions has to allow for it.
 */
export function anchorLoad(
  plan: AnchorPlan,
  slotsByDate: Map<string, Array<{ id: string }>>,
): Map<string, number> {
  const load = new Map<string, number>();

  for (const a of plan.assignments) {
    const total = (slotsByDate.get(a.date) ?? []).length;
    const working = total - a.anchorBreakSlotIds.length;

    if (a.anchorJudgeId) {
      load.set(a.anchorJudgeId, (load.get(a.anchorJudgeId) ?? 0) + working);
    }
    // PS do not break, so they cover every slot in the day.
    if (a.psJudgeId) {
      load.set(a.psJudgeId, (load.get(a.psJudgeId) ?? 0) + total);
    }
  }

  return load;
}
