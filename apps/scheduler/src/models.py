from pydantic import BaseModel
from typing import Optional

class TeamInput(BaseModel):
    id: str
    name: str
    track_id: Optional[str] = None

class JudgeInput(BaseModel):
    id: str
    name: str
    judge_type: str
    max_sessions: int = 10
    available_slot_ids: list[str] = []
    conflict_team_ids: list[str] = []
    expertise_track_ids: list[str] = []
    # L1 leadership, L2 MD, L3 ED, L4 senior, PS professional services,
    # V vendor. Anchors are decided before the solve; this tells the solver
    # which judges are eligible for the rotating seat.
    tier: str = "L3"
    # Has agreed to be interrupted. Schedulable, but used last so the reserve
    # stays intact where the pool allows.
    is_standby: bool = False


class AnchorAssignment(BaseModel):
    # A room-day's fixed seats, decided outside the solver. The anchor sits in
    # one room all day, stepping out on the slots listed in
    # anchor_break_slot_ids. PS do not break.
    room_id: str
    date: str
    anchor_judge_id: str | None = None
    ps_judge_id: str | None = None
    anchor_break_slot_ids: list[str] = []

class SlotInput(BaseModel):
    id: str
    date: str
    start_time: str
    end_time: str

class RoomInput(BaseModel):
    id: str
    name: str

class LockedSession(BaseModel):
    """
    A session that already exists and must not be moved.

    Manually placed sessions are not re-solved, but the solver still has to
    know about them: their room-slot is occupied, their judges are busy in
    that slot, and those judges have already used part of their session
    budget. Without this the solver produces a schedule that looks valid but
    double-books rooms and judges against work that already exists.
    """
    team_id: str
    room_id: str
    slot_id: str
    judge_ids: list[str] = []

class ScheduleRequest(BaseModel):
    event_id: str
    teams: list[TeamInput]
    judges: list[JudgeInput]
    slots: list[SlotInput]
    rooms: list[RoomInput]
    min_judges_per_team: int = 3
    max_judges_per_team: int = 5
    # Sessions that already exist and are being worked around. Teams in
    # `teams` are the ones still to schedule; these are not re-solved.
    locked_sessions: list[LockedSession] = []
    # Rooms this pass may use. Empty means any room. Set when remote teams must
    # go in a room with video conferencing.
    # What every panel must contain, as a list of {tiers, count}. Empty falls
    # back to the old min/max judge counts, so auto mode is unaffected.
    #
    # Expressed as data rather than code so a different event with a different
    # panel shape is a payload change, not a solver change.
    judge_composition: list[dict] = []
    restrict_to_room_ids: list[str] = []
    # Room-slot pairs that cannot be used — a room booked for something else.
    # Shaped as dicts rather than tuples so the JSON stays readable when a
    # schedule needs debugging.
    blocked_room_slots: list[dict] = []
    # Prefer placing this pass's teams in adjacent slots, so a vendor attending
    # half a day sees a contiguous block rather than scattered sessions. Slots
    # are ordered date-then-time, so this is measured within a day — index
    # spread across a two-day event would not mean calendar proximity.
    cluster: bool = False
    # Fixed anchor seats per room-day. The solver assigns these judges to every
    # session in that room on that day, and fills only the remaining seat.
    anchors: list[AnchorAssignment] = []
    # Judges holding an anchor seat. Excluded from the rotating pool so they
    # are not also picked as the third judge.
    reserved_judge_ids: list[str] = []

class SessionAssignment(BaseModel):
    team_id: str
    team_name: str
    room_id: str
    room_name: str
    slot_id: str
    slot_date: str
    slot_start: str
    slot_end: str
    judge_ids: list[str]
    judge_names: list[str]

class ScheduleResponse(BaseModel):
    success: bool
    sessions: list[SessionAssignment] = []
    unscheduled_teams: list[str] = []
    warnings: list[str] = []
    quality_score: float = 0.0
    solve_time_seconds: float = 0.0

class ValidateRequest(BaseModel):
    sessions: list[SessionAssignment]

class ValidateResponse(BaseModel):
    valid: bool
    violations: list[str] = []
