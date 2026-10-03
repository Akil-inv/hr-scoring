"""
Tests for the two mutants that survived CodeForge's layer 4.

Both are in code that the current API path never reaches, which is why nothing
killed them:

  solver.py:28  `success=False` in the empty-input guard. Nothing calls
                generate_schedule with an empty roster, so flipping it to True
                changed nothing any test observed.

  solver.py:98  `!= a.date` inside the anchors block. Anchoring was replaced by
                panel composition and the API now always sends `anchors: []`,
                so the whole block is unreachable in practice — while remaining
                part of the request contract and fully functional if anyone
                sends it.

Run:  cd apps/scheduler && python -m pytest tests/test_solver_guards.py -v
"""

import pytest

from src.models import (
    ScheduleRequest,
    TeamInput,
    JudgeInput,
    SlotInput,
    RoomInput,
    AnchorAssignment,
)
from src.solver import generate_schedule


DATE_A = "2026-08-28"
DATE_B = "2026-08-31"


def _slots(date: str, n: int, prefix: str) -> list[SlotInput]:
    return [
        SlotInput(
            id=f"{prefix}{i}",
            date=date,
            start_time=f"{9 + i:02d}:00",
            end_time=f"{9 + i:02d}:30",
        )
        for i in range(n)
    ]


def _judge(jid: str, tier: str, slot_ids: list[str], **kw) -> JudgeInput:
    return JudgeInput(
        id=jid,
        name=jid.upper(),
        judge_type="TECHNICAL",
        tier=tier,
        available_slot_ids=slot_ids,
        max_sessions=kw.pop("max_sessions", 40),
        **kw,
    )


# ─────────────────────────────────────────────────────────────────────────────
# solver.py:28 — the empty-input guard
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "missing",
    ["teams", "slots", "rooms", "judges"],
)
def test_empty_input_reports_failure(missing):
    """
    An empty roster must report success=False.

    The mutant flipped this to True, which would have produced a response
    claiming a successful solve with zero sessions — indistinguishable, to a
    caller reading `success`, from a schedule that placed every team. The
    coordinator UI would show "Generated 0 sessions" as a success.
    """
    slots = _slots(DATE_A, 2, "s")
    kwargs = dict(
        event_id="e1",
        teams=[TeamInput(id="t1", name="Team One")],
        judges=[
            _judge("md1", "L2", ["s0", "s1"]),
            _judge("ed1", "L3", ["s0", "s1"]),
            _judge("ps1", "PS", ["s0", "s1"]),
        ],
        slots=slots,
        rooms=[RoomInput(id="r1", name="Room A")],
        min_judges_per_team=3,
        max_judges_per_team=3,
    )
    kwargs[missing] = []

    res = generate_schedule(ScheduleRequest(**kwargs))

    assert res.success is False, (
        f"an empty {missing} list must not report success"
    )
    assert res.sessions == []
    assert res.warnings, "a failure must say why"


# ─────────────────────────────────────────────────────────────────────────────
# Not yet written
#
# A sanity case asserting the guard does *not* fire on a solvable request would
# make the tests above stronger — without it they would still pass if the solver
# returned success=False for everything.
#
# The obvious minimal fixture (1 team, 1 room, 2 slots, 3 judges, min=max=3)
# comes back INFEASIBLE, and reading the hard constraints does not explain why.
# Until that is understood, a sanity test would be asserting behaviour nobody
# has accounted for. See the note in the session handover.
#
# The anchors block (solver.py:98) is deliberately not tested here either: it is
# unreachable from the API, which always sends `anchors: []`. Deleting it is a
# better answer than covering it.
