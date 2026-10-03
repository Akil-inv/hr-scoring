from fastapi import FastAPI
from .models import ScheduleRequest, ScheduleResponse, ValidateRequest, ValidateResponse
from .solver import generate_schedule

app = FastAPI(title="Hackathon Schedule Generator", version="0.2.0")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/generate", response_model=ScheduleResponse)
def generate(req: ScheduleRequest):
    return generate_schedule(req)


@app.post("/validate", response_model=ValidateResponse)
def validate(req: ValidateRequest):
    violations = []
    
    # Check judge double-booking
    slot_judges: dict[str, set[str]] = {}
    for s in req.sessions:
        key = s.slot_id
        if key not in slot_judges:
            slot_judges[key] = set()
        for jid in s.judge_ids:
            if jid in slot_judges[key]:
                violations.append(f"Judge {jid} is double-booked in slot {s.slot_id}")
            slot_judges[key].add(jid)
    
    # Check room double-booking
    slot_rooms: dict[str, set[str]] = {}
    for s in req.sessions:
        key = s.slot_id
        if key not in slot_rooms:
            slot_rooms[key] = set()
        if s.room_id in slot_rooms[key]:
            violations.append(f"Room {s.room_name} is double-booked in slot {s.slot_id}")
        slot_rooms[key].add(s.room_id)
    
    # Check team double-booking
    team_slots: dict[str, set[str]] = {}
    for s in req.sessions:
        if s.team_id not in team_slots:
            team_slots[s.team_id] = set()
        if s.slot_id in team_slots[s.team_id]:
            violations.append(f"Team {s.team_name} is double-booked in slot {s.slot_id}")
        team_slots[s.team_id].add(s.slot_id)
    
    return ValidateResponse(valid=len(violations) == 0, violations=violations)
