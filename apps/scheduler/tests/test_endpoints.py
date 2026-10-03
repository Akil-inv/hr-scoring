"""
The three FastAPI endpoints.

Covers the mutants at main.py:10, :15 and :52. All three survive because
nothing calls these endpoints in a test — the API talks to them over HTTP and
the Python suite never has.

  main.py:10  `return {"status": "ok"}` in /health. Returning None gives the
              container healthcheck a 200 with a null body, which most probes
              still treat as healthy — a scheduler that has stopped working
              would keep reporting itself fine.

  main.py:15  `return generate_schedule(req)` in /generate. Returning None
              fails response_model validation, so a solve that worked would
              surface to the API as a 500.

  main.py:52  `valid=len(violations) == 0`. Flipped to `!=`, /validate reports
              a clean schedule as invalid and a double-booked one as valid.
              That is the endpoint whose whole job is to say whether a schedule
              is safe.

Run:  cd apps/scheduler && python -m pytest tests/test_endpoints.py -v
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


client = TestClient(app)


def _session(team_id, room_id, slot_id, judge_ids, **kw):
    return {
        "team_id": team_id,
        "team_name": kw.get("team_name", team_id.upper()),
        "room_id": room_id,
        "room_name": kw.get("room_name", room_id.upper()),
        "slot_id": slot_id,
        "slot_date": "2026-08-28",
        "slot_start": "09:00",
        "slot_end": "09:30",
        "judge_ids": judge_ids,
        "judge_names": [j.upper() for j in judge_ids],
    }


# ─────────────────────────────────────────────────────────────────────────────
# main.py:10 — /health
# ─────────────────────────────────────────────────────────────────────────────

def test_health_returns_a_status_body():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body is not None, (
        "a null body would still read as healthy to most probes, so a scheduler "
        "that had stopped working would keep reporting itself fine"
    )
    assert body == {"status": "ok"}


# ─────────────────────────────────────────────────────────────────────────────
# main.py:15 — /generate
# ─────────────────────────────────────────────────────────────────────────────

def test_generate_returns_a_schedule_response():
    """
    An empty roster is used deliberately: it exercises the endpoint and the
    response model without depending on the solver finding a feasible schedule,
    so this test cannot become flaky on constraint changes.
    """
    res = client.post(
        "/generate",
        json={
            "event_id": "e1",
            "teams": [],
            "judges": [],
            "slots": [],
            "rooms": [],
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body is not None
    assert "success" in body and "sessions" in body and "warnings" in body
    assert body["success"] is False
    assert body["warnings"], "a failed solve must say why"


def test_generate_rejects_a_malformed_payload():
    res = client.post("/generate", json={"event_id": "e1"})
    assert res.status_code == 422


# ─────────────────────────────────────────────────────────────────────────────
# main.py:52 — /validate
# ─────────────────────────────────────────────────────────────────────────────

def test_validate_accepts_a_clean_schedule():
    res = client.post(
        "/validate",
        json={
            "sessions": [
                _session("t1", "r1", "s1", ["j1", "j2", "j3"]),
                _session("t2", "r2", "s1", ["j4", "j5", "j6"]),
                _session("t3", "r1", "s2", ["j1", "j2", "j3"]),
            ]
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["valid"] is True
    assert body["violations"] == []


def test_validate_rejects_a_double_booked_judge():
    res = client.post(
        "/validate",
        json={
            "sessions": [
                _session("t1", "r1", "s1", ["j1", "j2", "j3"]),
                # j1 is in two rooms in the same slot.
                _session("t2", "r2", "s1", ["j1", "j5", "j6"]),
            ]
        },
    )
    body = res.json()
    assert body["valid"] is False
    assert any("double-booked" in v for v in body["violations"])
    assert any("j1" in v for v in body["violations"])


def test_validate_rejects_a_double_booked_room():
    res = client.post(
        "/validate",
        json={
            "sessions": [
                _session("t1", "r1", "s1", ["j1", "j2", "j3"]),
                _session("t2", "r1", "s1", ["j4", "j5", "j6"]),
            ]
        },
    )
    body = res.json()
    assert body["valid"] is False
    assert any("Room" in v for v in body["violations"])


def test_validate_rejects_a_double_booked_team():
    res = client.post(
        "/validate",
        json={
            "sessions": [
                _session("t1", "r1", "s1", ["j1", "j2", "j3"]),
                _session("t1", "r2", "s1", ["j4", "j5", "j6"]),
            ]
        },
    )
    body = res.json()
    assert body["valid"] is False
    assert any("Team" in v for v in body["violations"])


def test_validate_of_an_empty_schedule_is_valid():
    """Nothing to violate. Stated explicitly because `len([]) == 0` is exactly
    the expression the mutant inverts, and an empty list is the case where the
    two readings differ most quietly."""
    res = client.post("/validate", json={"sessions": []})
    body = res.json()
    assert body["valid"] is True
    assert body["violations"] == []
