"""
Tests for the scheduler's constraint logic.

The Python side has no type checking, so the errors that reach production here
are the ones a compiler would have caught elsewhere: a loop appended to inside
another loop, an index variable named `slot_idx` in one place and `slot_id_to_idx`
in another. Both happened, both raised at runtime, and both would have been
caught by any test that ran the solver once.

These exercise the constraints rather than the optimiser. Whether a schedule is
*good* is a judgement call and depends on weights that will keep changing;
whether it is *legal* is not, and that is what is worth pinning down.

    cd apps/scheduler
    pip install pytest
    pytest -v
"""


from src.models import ScheduleRequest, TeamInput, JudgeInput, SlotInput, RoomInput
from src.solver import generate_schedule


def build_request(**overrides):
    """
    A small feasible problem: four teams, two rooms, four slots.

    Deliberately small — CP-SAT will find an optimal answer in milliseconds, so
    a failure means a constraint is wrong rather than that the solver ran out of
    time.
    """
    judges = [
        JudgeInput(id="md1", name="MD One", judge_type="EXECUTIVE",
                   max_sessions=20, available_slot_ids=["s1", "s2", "s3", "s4"],
                   conflict_team_ids=[], expertise_track_ids=[], tier="L2"),
        JudgeInput(id="md2", name="MD Two", judge_type="EXECUTIVE",
                   max_sessions=20, available_slot_ids=["s1", "s2", "s3", "s4"],
                   conflict_team_ids=[], expertise_track_ids=[], tier="L2"),
        JudgeInput(id="ed1", name="ED One", judge_type="TECHNICAL",
                   max_sessions=20, available_slot_ids=["s1", "s2", "s3", "s4"],
                   conflict_team_ids=[], expertise_track_ids=[], tier="L3"),
        JudgeInput(id="svp1", name="SVP One", judge_type="TECHNICAL",
                   max_sessions=20, available_slot_ids=["s1", "s2", "s3", "s4"],
                   conflict_team_ids=[], expertise_track_ids=[], tier="L4"),
        JudgeInput(id="ps1", name="PS One", judge_type="TECHNICAL",
                   max_sessions=20, available_slot_ids=["s1", "s2", "s3", "s4"],
                   conflict_team_ids=[], expertise_track_ids=[], tier="PS"),
        JudgeInput(id="ps2", name="PS Two", judge_type="TECHNICAL",
                   max_sessions=20, available_slot_ids=["s1", "s2", "s3", "s4"],
                   conflict_team_ids=[], expertise_track_ids=[], tier="PS"),
    ]

    payload = dict(
        event_id="e1",
        teams=[TeamInput(id=f"t{i}", name=f"Team {i}", track_id="tr1") for i in range(1, 5)],
        judges=judges,
        slots=[SlotInput(id=f"s{i}", date="2026-08-28",
                         start_time=f"2026-08-28T0{i}:00:00Z",
                         end_time=f"2026-08-28T0{i}:20:00Z") for i in range(1, 5)],
        rooms=[RoomInput(id="r1", name="Room One"), RoomInput(id="r2", name="Room Two")],
        min_judges_per_team=3,
        max_judges_per_team=3,
    )
    payload.update(overrides)
    return ScheduleRequest(**payload)


def panel_of(result, team_id):
    """The judge ids assigned to a team."""
    for s in result.sessions:
        if s.team_id == team_id:
            return s.judge_ids
    return []


class TestBasicFeasibility:
    def test_every_team_is_scheduled_once(self):
        result = generate_schedule(build_request())
        assert result.success
        assert len(result.sessions) == 4
        assert len({s.team_id for s in result.sessions}) == 4

    def test_a_room_holds_one_team_per_slot(self):
        result = generate_schedule(build_request())
        seen = set()
        for s in result.sessions:
            key = (s.slot_id, s.room_id)
            assert key not in seen, f"{key} was double-booked"
            seen.add(key)

    def test_a_judge_is_in_one_place_at_a_time(self):
        result = generate_schedule(build_request())
        busy = {}
        for s in result.sessions:
            for j in s.judge_ids:
                key = (j, s.slot_id)
                assert key not in busy, f"{j} is in two rooms in slot {s.slot_id}"
                busy[key] = True


class TestPanelComposition:
    """
    The rule that replaced anchoring: one MD, one ED or SVP, one PS.

    Stated as exact counts rather than minimums — a panel of two MDs satisfies
    "at least one MD" and is not what was asked for.
    """

    COMPOSITION = [
        {"tiers": ["PS"], "count": 1},
        {"tiers": ["L2"], "count": 1},
        {"tiers": ["L3", "L4"], "count": 1},
    ]

    def tier_of(self, judge_id):
        return {"md1": "L2", "md2": "L2", "ed1": "L3",
                "svp1": "L4", "ps1": "PS", "ps2": "PS"}[judge_id]

    def test_every_panel_has_exactly_one_of_each(self):
        result = generate_schedule(build_request(judge_composition=self.COMPOSITION))
        assert result.success

        for session in result.sessions:
            tiers = [self.tier_of(j) for j in session.judge_ids]
            assert tiers.count("L2") == 1, f"expected one MD, got {tiers}"
            assert sum(t in ("L3", "L4") for t in tiers) == 1, f"expected one ED/SVP, got {tiers}"
            assert tiers.count("PS") == 1, f"expected one PS, got {tiers}"

    def test_composition_is_infeasible_without_enough_of_a_tier(self):
        """
        Two rooms need two MDs free at once. With one, at most one room can run
        per slot — four teams across four slots still fits, so this checks the
        constraint holds rather than that it fails.
        """
        req = build_request(judge_composition=self.COMPOSITION)
        req.judges = [j for j in req.judges if j.id != "md2"]
        result = generate_schedule(req)

        if result.success:
            for session in result.sessions:
                assert "md1" in session.judge_ids


class TestAvailability:
    def test_a_judge_is_never_scheduled_outside_their_window(self):
        req = build_request()
        for j in req.judges:
            if j.id == "ed1":
                j.available_slot_ids = ["s1"]

        result = generate_schedule(req)
        assert result.success

        for session in result.sessions:
            if "ed1" in session.judge_ids:
                assert session.slot_id == "s1"


class TestBlockedRooms:
    """
    Room unavailability rides on the same mechanism as locked sessions — an
    unavailable room is, to the solver, an occupied one. This is the regression
    that broke the scheduler once, when the loop reading these was placed inside
    the loop above it.
    """

    def test_a_blocked_room_slot_is_never_used(self):
        blocked = [
            {"room_id": "r1", "slot_id": "s1"},
            {"room_id": "r1", "slot_id": "s2"},
        ]
        result = generate_schedule(build_request(blocked_room_slots=blocked))
        assert result.success

        for session in result.sessions:
            assert not (session.room_id == "r1" and session.slot_id in ("s1", "s2"))

    def test_an_unknown_id_in_blocked_slots_is_ignored(self):
        """A stale exclusion should not make the whole solve fail."""
        result = generate_schedule(build_request(
            blocked_room_slots=[{"room_id": "does-not-exist", "slot_id": "s1"}],
        ))
        assert result.success


class TestConflicts:
    def test_a_conflicted_judge_never_sees_that_team(self):
        req = build_request()
        for j in req.judges:
            if j.id == "ed1":
                j.conflict_team_ids = ["t1"]

        result = generate_schedule(req)
        assert result.success
        assert "ed1" not in panel_of(result, "t1")


class TestRoomRestriction:
    def test_a_pass_restricted_to_a_room_uses_only_that_room(self):
        result = generate_schedule(build_request(restrict_to_room_ids=["r2"]))
        assert result.success
        assert all(s.room_id == "r2" for s in result.sessions)
