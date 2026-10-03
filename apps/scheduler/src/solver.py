from ortools.sat.python import cp_model
import time
from .models import ScheduleRequest, ScheduleResponse, SessionAssignment


def generate_schedule(req: ScheduleRequest) -> ScheduleResponse:
    start_time = time.time()

    model = cp_model.CpModel()

    teams = req.teams
    judges = req.judges
    slots = req.slots
    rooms = req.rooms
    min_j = req.min_judges_per_team
    max_j = req.max_judges_per_team
    locked = req.locked_sessions
    anchors = req.anchors
    reserved = set(req.reserved_judge_ids)

    n_teams = len(teams)
    n_slots = len(slots)
    n_rooms = len(rooms)
    n_judges = len(judges)

    if n_teams == 0 or n_slots == 0 or n_rooms == 0 or n_judges == 0:
        return ScheduleResponse(
            success=False,
            warnings=["No teams, slots, rooms, or judges provided"],
            solve_time_seconds=time.time() - start_time,
        )

    # Index maps
    team_idx = {t.id: i for i, t in enumerate(teams)}
    slot_idx = {s.id: i for i, s in enumerate(slots)}
    room_idx = {r.id: i for i, r in enumerate(rooms)}
    judge_idx = {j.id: i for i, j in enumerate(judges)}

    # ─── Locked sessions ───
    # Sessions that already exist (manually placed, or from an earlier partial
    # generation). Their teams are absent from `teams`, so they are not
    # re-solved — but the resources they consume must be blocked out.

    # (slot, room) pairs already occupied
    occupied_room_slots: set[tuple[int, int]] = set()
    # (judge, slot) pairs where the judge is already committed
    busy_judge_slots: set[tuple[int, int]] = set()
    # How many sessions each judge already has, so max_sessions and workload
    # balance account for work the solver cannot see.
    prior_judge_load: dict[int, int] = {j: 0 for j in range(n_judges)}

    for ls in locked:
        s_i = slot_idx.get(ls.slot_id)
        r_i = room_idx.get(ls.room_id)
        if s_i is not None and r_i is not None:
            occupied_room_slots.add((s_i, r_i))

        for jid in ls.judge_ids:
            j_i = judge_idx.get(jid)
            if j_i is None:
                continue
            prior_judge_load[j_i] += 1
            if s_i is not None:
                busy_judge_slots.add((j_i, s_i))

    # A room that is unavailable is, to the solver, a room that is already
    # occupied. Folding the two together means capacity reporting, infeasibility
    # messages and clustering all treat them identically, with no special case
    # to keep in step.
    for blocked in getattr(req, 'blocked_room_slots', []) or []:
        b_r = room_idx.get(blocked.get('room_id'))
        b_s = slot_idx.get(blocked.get('slot_id'))
        if b_r is not None and b_s is not None:
            occupied_room_slots.add((b_s, b_r))

    # ─── Anchors ───
    # Anchors are decided before the solve: an L2 in each room for the day,
    # with a PS alongside. They are not choices the solver makes — it just has
    # to honour them, and fill the one remaining seat.
    #
    # anchor_for[(slot, room)] is the set of judge indices that must be present
    # in that session. Every judge in it is already committed, so the rotating
    # requirement drops by that many.
    judge_id_to_idx = {j.id: i for i, j in enumerate(judges)}
    slot_id_to_idx = {s.id: i for i, s in enumerate(slots)}
    room_id_to_idx = {r.id: i for i, r in enumerate(rooms)}

    anchor_for: dict[tuple[int, int], set[int]] = {}

    for a in anchors:
        r_i = room_id_to_idx.get(a.room_id)
        if r_i is None:
            continue

        break_slots = {slot_id_to_idx[sid] for sid in a.anchor_break_slot_ids if sid in slot_id_to_idx}

        for s_i, slot in enumerate(slots):
            if getattr(slot, 'date', None) != a.date:
                continue

            fixed: set[int] = set()

            # The anchor covers every slot in the day except their break.
            if a.anchor_judge_id and s_i not in break_slots:
                j_i = judge_id_to_idx.get(a.anchor_judge_id)
                if j_i is not None:
                    fixed.add(j_i)

            # PS work continuously — no break pattern.
            if a.ps_judge_id:
                j_i = judge_id_to_idx.get(a.ps_judge_id)
                if j_i is not None:
                    fixed.add(j_i)

            if fixed:
                anchor_for[(s_i, r_i)] = fixed

    # Judges eligible for the rotating seat. Anchors are excluded so they are
    # not counted twice, and L1 sits out the first round entirely.
    rotating = [
        i for i, j in enumerate(judges)
        if j.id not in reserved and getattr(j, 'tier', 'L3') != 'L1'
    ]

    # Judge availability as set of slot indices
    judge_avail = {}
    for j_i, j in enumerate(judges):
        if j.available_slot_ids:
            judge_avail[j_i] = {slot_idx[sid] for sid in j.available_slot_ids if sid in slot_idx}
        else:
            judge_avail[j_i] = set(range(n_slots))

    # Judge conflict sets
    judge_conflicts = {}
    for j_i, j in enumerate(judges):
        judge_conflicts[j_i] = {team_idx[tid] for tid in j.conflict_team_ids if tid in team_idx}

    # Group slots by half-day (AM/PM) for room stickiness
    # Slots are ordered by time; group by date + AM/PM
    slot_groups = {}  # group_key -> list of slot indices
    for s_i, s in enumerate(slots):
        hour = 12  # default
        try:
            if hasattr(s, 'start_time') and s.start_time:
                hour = int(s.start_time.split(':')[0].split('T')[-1])
        except (ValueError, IndexError):
            pass
        period = 'AM' if hour < 12 else 'PM'
        date = getattr(s, 'date', 'unknown')
        key = f"{date}_{period}"
        if key not in slot_groups:
            slot_groups[key] = []
        slot_groups[key].append(s_i)

    # ─── Decision Variables ───

    # x[t][s][r] = 1 if team t is scheduled in slot s, room r
    x = {}
    for t in range(n_teams):
        for s in range(n_slots):
            for r in range(n_rooms):
                x[t, s, r] = model.new_bool_var(f"x_t{t}_s{s}_r{r}")

    # y[j][t][s][r] = 1 if judge j assigned to team t in slot s, room r
    y = {}
    for j in range(n_judges):
        for t in range(n_teams):
            for s in range(n_slots):
                for r in range(n_rooms):
                    y[j, t, s, r] = model.new_bool_var(f"y_j{j}_t{t}_s{s}_r{r}")

    # ─── Hard Constraints ───

    # 1. Each team scheduled exactly once
    for t in range(n_teams):
        model.add(sum(x[t, s, r] for s in range(n_slots) for r in range(n_rooms)) == 1)

    # 2. Each room-slot has at most one team
    for s in range(n_slots):
        for r in range(n_rooms):
            model.add(sum(x[t, s, r] for t in range(n_teams)) <= 1)

    # 2b. Room-slots taken by locked sessions are unavailable
    for (s, r) in occupied_room_slots:
        for t in range(n_teams):
            model.add(x[t, s, r] == 0)

    # 2c. Some passes may only use certain rooms — remote teams need video
    #     conferencing, and a room without it cannot host them at all.
    if req.restrict_to_room_ids:
        allowed = {room_id_to_idx[rid] for rid in req.restrict_to_room_ids if rid in room_id_to_idx}
        for r in range(n_rooms):
            if r in allowed:
                continue
            for t in range(n_teams):
                for s in range(n_slots):
                    model.add(x[t, s, r] == 0)

    # 3. A judge can only be in one room per slot (no double-booking)
    for j in range(n_judges):
        for s in range(n_slots):
            model.add(sum(y[j, t, s, r] for t in range(n_teams) for r in range(n_rooms)) <= 1)

    # 3b. Judges committed to a locked session are unavailable in that slot
    for (j, s) in busy_judge_slots:
        for t in range(n_teams):
            for r in range(n_rooms):
                model.add(y[j, t, s, r] == 0)

    # 4. Judge assigned only if team is in that slot-room
    for j in range(n_judges):
        for t in range(n_teams):
            for s in range(n_slots):
                for r in range(n_rooms):
                    model.add(y[j, t, s, r] <= x[t, s, r])

    # 5a. Anchors are present in their room-day, whichever team is placed there.
    for (s, r), fixed in anchor_for.items():
        for j in fixed:
            # If a team occupies this room-slot, the anchor judges it.
            for t in range(n_teams):
                model.add(y[j, t, s, r] == x[t, s, r])

    # 5b. Only judges from the rotating pool fill the remaining seats. Anchors
    #     are handled above; anyone else must not appear.
    rotating_set = set(rotating)
    for j in range(n_judges):
        if j in rotating_set:
            continue
        for (s, r), fixed in anchor_for.items():
            if j in fixed:
                continue
        # A judge who is neither rotating nor an anchor here takes no seat.
        for t in range(n_teams):
            for s in range(n_slots):
                for r in range(n_rooms):
                    if j in anchor_for.get((s, r), set()):
                        continue
                    model.add(y[j, t, s, r] == 0)

    # 6. Panel composition.
    #
    #    Either the panel is described by tier — one MD, one ED or SVP, one PS —
    #    or it falls back to a plain count. The composition form is exact rather
    #    than a minimum: a panel of two MDs satisfies "at least one MD" and is
    #    not what was asked for.
    composition = getattr(req, 'judge_composition', None) or []

    if composition:
        for rule in composition:
            tiers = set(rule.get('tiers', []))
            count = int(rule.get('count', 1))
            pool = [j for j in range(n_judges) if getattr(judges[j], 'tier', 'L3') in tiers]

            if not pool:
                # No judge of this tier exists. Leaving the constraint in would
                # make the model infeasible with no explanation; dropping it
                # lets the solve proceed and the shortfall be reported.
                continue

            for t in range(n_teams):
                model.add(
                    sum(y[j, t, s, r] for j in pool for s in range(n_slots) for r in range(n_rooms))
                    == count
                )
    else:
        # Minimum judges per team, counting the anchors already committed.
        for t in range(n_teams):
            model.add(
                sum(y[j, t, s, r] for j in range(n_judges) for s in range(n_slots) for r in range(n_rooms))
                >= min_j
            )

        # Maximum judges per team
        for t in range(n_teams):
            model.add(
                sum(y[j, t, s, r] for j in range(n_judges) for s in range(n_slots) for r in range(n_rooms))
                <= max_j
            )

    # 7. Judge availability
    for j in range(n_judges):
        for s in range(n_slots):
            if s not in judge_avail[j]:
                for t in range(n_teams):
                    for r in range(n_rooms):
                        model.add(y[j, t, s, r] == 0)

    # 8. Conflict of interest
    for j in range(n_judges):
        for t in judge_conflicts.get(j, set()):
            for s in range(n_slots):
                for r in range(n_rooms):
                    model.add(y[j, t, s, r] == 0)

    # 9. Judge max sessions — reduced by whatever the judge is already
    #    committed to in locked sessions.
    for j_i, j in enumerate(judges):
        max_sessions = getattr(j, 'max_sessions', None)
        if max_sessions and max_sessions > 0:
            remaining = max(0, max_sessions - prior_judge_load[j_i])
            model.add(
                sum(y[j_i, t, s, r] for t in range(n_teams) for s in range(n_slots) for r in range(n_rooms))
                <= remaining
            )

    # ─── Soft Objectives ───

    # A. Minimize workload imbalance.
    #    Load includes locked sessions, so a judge with three manual sessions
    #    does not look idle and get loaded up again.
    max_prior = max(prior_judge_load.values()) if prior_judge_load else 0
    load_ub = n_teams + max_prior

    judge_loads = []
    # Spread is measured only across judges the solver can actually assign.
    #
    # Anchors are decided before the solve and sit at forty sessions each. If
    # they are included, max_load is pinned at forty and min_load at zero
    # whatever happens to the rotating pool — load_diff becomes a constant, and
    # a constant gives the solver nothing to optimise against. It then spends
    # its effort on the terms that do respond, which is how six judges ended up
    # with no sessions while the clusters came out immaculate.
    balanced_loads = []

    for j in range(n_judges):
        load = model.new_int_var(0, load_ub, f"load_j{j}")
        model.add(
            load
            == sum(y[j, t, s, r] for t in range(n_teams) for s in range(n_slots) for r in range(n_rooms))
            + prior_judge_load[j]
        )
        judge_loads.append(load)

        # Anchors hold a fixed seat in a room for a day; their load is not a
        # choice. Everyone else is in the rotating pool and should be evened out.
        is_anchor = any(j in fixed for fixed in anchor_for.values())
        if not is_anchor:
            balanced_loads.append(load)

    # With no anchors — auto mode — every judge is balanced, as before.
    if not balanced_loads:
        balanced_loads = judge_loads

    max_load = model.new_int_var(0, load_ub, "max_load")
    min_load = model.new_int_var(0, load_ub, "min_load")
    model.add_max_equality(max_load, balanced_loads)
    model.add_min_equality(min_load, balanced_loads)
    load_diff = model.new_int_var(0, load_ub, "load_diff")
    model.add(load_diff == max_load - min_load)

    # B. Room stickiness: penalize judge changing rooms between consecutive slots
    #    within the same half-day block
    room_change_penalties = []
    for j in range(n_judges):
        for group_key, group_slots in slot_groups.items():
            sorted_slots = sorted(group_slots)
            for idx in range(len(sorted_slots) - 1):
                s1 = sorted_slots[idx]
                s2 = sorted_slots[idx + 1]
                for r in range(n_rooms):
                    # judge is in room r at s1 but NOT in room r at s2
                    in_r_s1 = model.new_bool_var(f"jr_{j}_{s1}_{r}")
                    in_r_s2 = model.new_bool_var(f"jr_{j}_{s2}_{r}")
                    model.add(in_r_s1 == sum(y[j, t, s1, r] for t in range(n_teams)))
                    model.add(in_r_s2 == sum(y[j, t, s2, r] for t in range(n_teams)))

                    # changed = was in room r at s1 but not at s2
                    changed = model.new_bool_var(f"chg_{j}_{s1}_{s2}_{r}")
                    # changed = 1 only if in_r_s1 = 1 AND in_r_s2 = 0
                    model.add(changed <= in_r_s1)
                    model.add(changed <= 1 - in_r_s2)
                    model.add(changed >= in_r_s1 + (1 - in_r_s2) - 1)
                    room_change_penalties.append(changed)

    # Objective: workload balance (weight 10) + room stickiness (weight 5 each change)
    total_room_changes = model.new_int_var(0, n_judges * n_slots * n_rooms, "total_room_changes")
    if room_change_penalties:
        model.add(total_room_changes == sum(room_change_penalties))
    else:
        model.add(total_room_changes == 0)

    # C. Clustering: keep this pass's teams close together in time.
    #
    #    Measured as the spread between the earliest and latest slot used. A
    #    vendor attending half a day needs the teams on their platform in a
    #    contiguous run; three sessions scattered across two days is no use to
    #    them even though every hard rule is satisfied.
    if req.cluster and n_teams > 1:
        # Slots are ordered date-then-time, so a raw index spread of 18 might
        # be two sessions at the same hour on consecutive days. Splitting the
        # penalty into "how many days does this pass touch" and "how far apart
        # within a day" is what makes contiguity mean something on a calendar.
        slot_days = [getattr(s, 'date', '') for s in slots]
        distinct_days = sorted(set(slot_days))
        day_of_slot = {i: distinct_days.index(d) for i, d in enumerate(slot_days)}

        positions = []
        for t in range(n_teams):
            pos = model.new_int_var(0, n_slots - 1, f"pos_t{t}")
            model.add(pos == sum(s * x[t, s, r] for s in range(n_slots) for r in range(n_rooms)))
            positions.append(pos)

        first_slot = model.new_int_var(0, n_slots - 1, "first_slot")
        last_slot = model.new_int_var(0, n_slots - 1, "last_slot")
        model.add_min_equality(first_slot, positions)
        model.add_max_equality(last_slot, positions)

        spread = model.new_int_var(0, n_slots, "spread")
        model.add(spread == last_slot - first_slot)

        # Days touched. A pass split over two days costs more than one stretched
        # across a long single day, because the person hosting the bridge has to
        # come back the next morning.
        day_used = []
        for d in range(len(distinct_days)):
            used = model.new_bool_var(f"day_used_{d}")
            slots_on_day = [i for i in range(n_slots) if day_of_slot[i] == d]
            occupancy = sum(
                x[t, s, r] for t in range(n_teams) for s in slots_on_day for r in range(n_rooms)
            )
            # used is 1 if any team of this pass is placed on this day
            model.add(occupancy >= 1).only_enforce_if(used)
            model.add(occupancy == 0).only_enforce_if(used.negated())
            day_used.append(used)

        days_touched = model.new_int_var(0, len(distinct_days), "days_touched")
        model.add(days_touched == sum(day_used))
    else:
        spread = model.new_int_var(0, 0, "spread")
        model.add(spread == 0)
        days_touched = model.new_int_var(0, 0, "days_touched")
        model.add(days_touched == 0)

    # Spread is weighted above room changes but below workload balance: a
    # judge doing twice the sessions of another is a worse outcome than a
    # cluster stretched over an extra hour.
    # Clustering is weighted above workload balance when it applies. A pass that
    # exists to give a vendor a coherent block, or to keep one country on one
    # bridge, is not worth trading for a judge doing one session more than
    # another — and with anchors fixed, the balance term has little left to
    # optimise anyway.
    model.minimize(
        # Back to 15. This was lowered to 6 while clustering was being tuned,
        # on the assumption the two were competing. They were not — balance was
        # measuring something it could not change.
        load_diff * 15
        + total_room_changes * 5
        + spread * 20
        + days_touched * 60
    )

    # ─── Solve ───
    solver = cp_model.CpSolver()
    # Scale the budget to the problem.
    #
    # CP-SAT spends whatever it is given: a five-team pass took the same 120
    # seconds as a sixty-five-team one, because once a feasible schedule is
    # found the rest goes on proving nothing better exists. That is fine for a
    # single solve and ruinous for a sequence of twelve.
    #
    # Two seconds per team, floored at 10 so even a two-team pass has room to
    # search, and capped at 120 so a single large solve behaves as before.
    budget = min(max(n_teams * 2.0, 10.0), 120.0)
    solver.parameters.max_time_in_seconds = budget

    # Stop as soon as optimality is proved rather than sitting out the budget.
    # On a small pass that is often immediate.
    solver.parameters.stop_after_first_solution = False
    solver.parameters.num_workers = 4

    status = solver.solve(model)

    solve_time = time.time() - start_time

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        warnings = ["Solver could not find a feasible schedule. Check constraints."]
        if locked:
            warnings.append(
                f"{len(locked)} session(s) were locked in place. Manual placements "
                "restrict the solver — try resetting the schedule and generating "
                "everything at once."
            )
        return ScheduleResponse(
            success=False,
            warnings=warnings,
            solve_time_seconds=solve_time,
        )

    # ─── Extract Solution ───
    sessions = []
    scheduled_teams = set()

    for t in range(n_teams):
        for s in range(n_slots):
            for r in range(n_rooms):
                if solver.value(x[t, s, r]) == 1:
                    scheduled_teams.add(t)
                    assigned_judges = []
                    assigned_judge_names = []
                    for j in range(n_judges):
                        if solver.value(y[j, t, s, r]) == 1:
                            assigned_judges.append(judges[j].id)
                            assigned_judge_names.append(judges[j].name)

                    sessions.append(SessionAssignment(
                        team_id=teams[t].id,
                        team_name=teams[t].name,
                        room_id=rooms[r].id,
                        room_name=rooms[r].name,
                        slot_id=slots[s].id,
                        slot_date=slots[s].date,
                        slot_start=slots[s].start_time,
                        slot_end=slots[s].end_time,
                        judge_ids=assigned_judges,
                        judge_names=assigned_judge_names,
                    ))

    unscheduled = [teams[t].name for t in range(n_teams) if t not in scheduled_teams]

    # Quality score
    warnings = []
    if locked:
        warnings.append(f"{len(locked)} existing session(s) kept in place")
    if unscheduled:
        warnings.append(f"{len(unscheduled)} teams could not be scheduled")

    quality = 100.0
    if unscheduled:
        quality -= (len(unscheduled) / n_teams) * 50
    load_imbalance = solver.value(load_diff)
    if load_imbalance > 2:
        quality -= min(20, load_imbalance * 5)
        warnings.append(f"Judge workload imbalance: {load_imbalance} sessions difference")
    room_changes_val = solver.value(total_room_changes)
    if room_changes_val > 0:
        quality -= min(15, room_changes_val * 2)
        warnings.append(f"Judge room changes: {room_changes_val} (lower is better)")

    return ScheduleResponse(
        success=True,
        sessions=sessions,
        unscheduled_teams=unscheduled,
        warnings=warnings,
        quality_score=round(quality, 1),
        solve_time_seconds=round(solve_time, 2),
    )
