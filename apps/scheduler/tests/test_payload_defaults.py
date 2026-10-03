"""
Payload defaults and the rotating-pool tier filter.

These cover three mutants that survive because the behaviour they change is a
default nobody states explicitly:

  models.py:23  `is_standby: bool = False`
  models.py:89  `cluster: bool = False`
  solver.py:122 `getattr(j, 'tier', 'L3') != 'L1'` in the rotating pool

A default is exactly the kind of thing that produces a plausible, wrong result:
the EC2 schedule with two judges per panel looked entirely normal, and so would
a solve where every judge was treated as standby, or clustering was applied to
an event that never asked for it.

Run:  cd apps/scheduler && python -m pytest tests/test_payload_defaults.py -v
"""

import pytest

from src.models import (
    ScheduleRequest,
    TeamInput,
    JudgeInput,
    SlotInput,
    RoomInput,
)
from src.solver import generate_schedule


DATE_A = "2026-08-28"


def _slots(n: int, prefix: str = "s") -> list[SlotInput]:
    return [
        SlotInput(
            id=f"{prefix}{i}",
            date=DATE_A,
            start_time=f"{9 + i:02d}:00",
            end_time=f"{9 + i:02d}:30",
        )
        for i in range(n)
    ]


def _judge(jid: str, tier: str, slot_ids: list[str]) -> JudgeInput:
    return JudgeInput(
        id=jid,
        name=jid.upper(),
        judge_type="TECHNICAL",
        tier=tier,
        available_slot_ids=slot_ids,
        max_sessions=40,
    )


# ─────────────────────────────────────────────────────────────────────────────
# models.py:23 — is_standby
# ─────────────────────────────────────────────────────────────────────────────

def test_is_standby_defaults_to_false():
    """
    A judge is not standby unless the payload says so.

    Flipped, every judge becomes a reserve — "used last so the reserve stays
    intact" applied to the whole pool, which is not a reserve at all. The solve
    still succeeds and the schedule still looks reasonable.
    """
    j = JudgeInput(id="j1", name="J1", judge_type="TECHNICAL")
    assert j.is_standby is False


def test_is_standby_is_settable():
    assert JudgeInput(
        id="j1", name="J1", judge_type="TECHNICAL", is_standby=True
    ).is_standby is True


# ─────────────────────────────────────────────────────────────────────────────
# models.py:89 — cluster
# ─────────────────────────────────────────────────────────────────────────────

def _minimal_request(**overrides) -> ScheduleRequest:
    base = dict(
        event_id="e1",
        teams=[TeamInput(id="t1", name="Team One")],
        judges=[_judge("j1", "L2", ["s0"])],
        slots=_slots(1),
        rooms=[RoomInput(id="r1", name="Room A")],
    )
    base.update(overrides)
    return ScheduleRequest(**base)


def test_cluster_defaults_to_false():
    """
    Clustering is opt-in per pass.

    Flipped, every solve groups teams into contiguous blocks whether or not a
    vendor is attending — reordering the whole schedule for a preference nobody
    expressed. This is also the flag Track 1 use-case grouping would ride on, so
    it is worth knowing the default is what it claims before anything depends
    on it.
    """
    assert _minimal_request().cluster is False


def test_cluster_is_settable():
    assert _minimal_request(cluster=True).cluster is True


def test_other_payload_defaults():
    """The rest of the defaults that decide solver behaviour, stated once so a
    change to any of them fails here rather than in a schedule."""
    req = _minimal_request()
    assert req.min_judges_per_team == 3
    assert req.max_judges_per_team == 5
    assert req.locked_sessions == []
    assert req.judge_composition == []
    assert req.restrict_to_room_ids == []
    assert req.blocked_room_slots == []
    assert req.anchors == []
    assert req.reserved_judge_ids == []


def test_judge_defaults():
    j = JudgeInput(id="j1", name="J1", judge_type="TECHNICAL")
    assert j.tier == "L3"
    assert j.max_sessions == 10
    assert j.available_slot_ids == []
    assert j.conflict_team_ids == []
    assert j.expertise_track_ids == []


# ─────────────────────────────────────────────────────────────────────────────
# solver.py:122 — L1 is excluded from the rotating pool
# ─────────────────────────────────────────────────────────────────────────────

def test_l1_judges_are_not_eligible_for_the_rotating_seat():
    """
    L1 is leadership, held back for the final round, and must never be drawn
    into a rotating seat.

    The mutant flips `!= 'L1'` to `== 'L1'`, which inverts the pool: only L1
    judges become eligible and everyone else is excluded.

    This is asserted through failure rather than success, so it does not depend
    on the solver finding a feasible schedule. With a pool of L1 judges only,
    the rotating pool is empty and no team can be staffed. Under the mutant the
    same request becomes solvable, because L1 is then the only eligible tier.
    """
    req = ScheduleRequest(
        event_id="e1",
        teams=[TeamInput(id="t1", name="Team One")],
        judges=[
            _judge("lead1", "L1", ["s0", "s1"]),
            _judge("lead2", "L1", ["s0", "s1"]),
            _judge("lead3", "L1", ["s0", "s1"]),
        ],
        slots=_slots(2),
        rooms=[RoomInput(id="r1", name="Room A")],
        min_judges_per_team=3,
        max_judges_per_team=3,
    )

    res = generate_schedule(req)

    assert res.success is False, (
        "a pool of L1 judges only leaves no rotating seat to fill; the solve "
        "must not succeed"
    )
    assert all(
        "lead" not in jid
        for s in res.sessions
        for jid in s.judge_ids
    ), "no L1 judge may hold a rotating seat"


def test_reserved_judges_are_excluded_from_the_rotating_pool():
    """`reserved_judge_ids` holds judges out of the pool. Same shape as the L1
    rule and the same failure mode if it stops working."""
    req = ScheduleRequest(
        event_id="e1",
        teams=[TeamInput(id="t1", name="Team One")],
        judges=[
            _judge("a", "L2", ["s0", "s1"]),
            _judge("b", "L3", ["s0", "s1"]),
            _judge("c", "PS", ["s0", "s1"]),
        ],
        slots=_slots(2),
        rooms=[RoomInput(id="r1", name="Room A")],
        min_judges_per_team=3,
        max_judges_per_team=3,
        reserved_judge_ids=["a", "b", "c"],
    )

    res = generate_schedule(req)
    assert res.success is False, (
        "every judge reserved leaves nobody to fill a seat"
    )
