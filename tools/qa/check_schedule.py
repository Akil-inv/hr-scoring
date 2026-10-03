#!/usr/bin/env python3
"""
Schedule invariant checker for HackJudge.

Takes a ScheduleRequest and the ScheduleResponse the solver produced, and
asserts the schedule is *legal*. Independent of the solver: it never imports
ortools or apps.scheduler, so a bug in the solver cannot hide itself here.

    python check_schedule.py request.json response.json
    python check_schedule.py request.json response.json --json

Exit codes:
    0  no errors (warnings may still be present)
    1  one or more ERROR-level violations
    2  bad input

Designed to be used three ways:
  1. CLI, against a real solve, before an event.
  2. Imported by pytest: `from check_schedule import check; check(req, resp)`.
  3. Under Hypothesis, generating random events and asserting invariants hold.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable

ERROR = "ERROR"
WARN = "WARN"
INFO = "INFO"


@dataclass
class Finding:
    level: str
    code: str
    message: str
    detail: dict = field(default_factory=dict)

    def __str__(self) -> str:
        d = ""
        if self.detail:
            items = ", ".join(f"{k}={v}" for k, v in self.detail.items())
            d = f"  [{items}]"
        return f"{self.level:<5} {self.code:<22} {self.message}{d}"


class Report:
    def __init__(self) -> None:
        self.findings: list[Finding] = []

    def add(self, level: str, code: str, message: str, **detail: Any) -> None:
        self.findings.append(Finding(level, code, message, detail))

    def error(self, code: str, message: str, **d: Any) -> None:
        self.add(ERROR, code, message, **d)

    def warn(self, code: str, message: str, **d: Any) -> None:
        self.add(WARN, code, message, **d)

    def info(self, code: str, message: str, **d: Any) -> None:
        self.add(INFO, code, message, **d)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.level == ERROR]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.level == WARN]

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "error_count": len(self.errors),
            "warning_count": len(self.warnings),
            "findings": [asdict(f) for f in self.findings],
        }


# ─────────────────────────────────────────────────────────────────────────────
# Normalisers — the request uses a few loosely-typed dict fields. Rather than
# assume one spelling, accept the plausible ones and report what was parsed, so
# a misread is visible rather than silent.
# ─────────────────────────────────────────────────────────────────────────────

def _norm_composition(raw: Iterable[dict], report: Report) -> list[tuple[set[str], int]]:
    """judge_composition is `list[dict]` of {tiers, count}. Accept variants."""
    out: list[tuple[set[str], int]] = []
    for i, entry in enumerate(raw or []):
        if not isinstance(entry, dict):
            report.error("COMPOSITION_SHAPE",
                         "judge_composition entry is not an object", index=i, value=repr(entry))
            continue
        tiers = entry.get("tiers", entry.get("tier", entry.get("judge_tiers")))
        if isinstance(tiers, str):
            tiers = [tiers]
        if not tiers:
            report.error("COMPOSITION_SHAPE",
                         "judge_composition entry has no tiers key", index=i, keys=list(entry))
            continue
        count = entry.get("count", entry.get("n", entry.get("quantity", 1)))
        try:
            count = int(count)
        except (TypeError, ValueError):
            report.error("COMPOSITION_SHAPE",
                         "judge_composition count is not an integer", index=i, value=repr(count))
            continue
        out.append((set(str(t).upper() for t in tiers), count))
    if out:
        readable = " + ".join(f"{c}x({'|'.join(sorted(t))})" for t, c in out)
        report.info("COMPOSITION_PARSED", f"panel rule read as: {readable}")
    return out


def _norm_room_slot_pairs(raw: Iterable[dict], report: Report, code: str) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for i, entry in enumerate(raw or []):
        if not isinstance(entry, dict):
            report.error(code, "entry is not an object", index=i, value=repr(entry))
            continue
        room = entry.get("room_id", entry.get("roomId", entry.get("room")))
        slot = entry.get("slot_id", entry.get("slotId", entry.get("slot")))
        if room is None or slot is None:
            report.error(code, "entry missing room_id/slot_id", index=i, keys=list(entry))
            continue
        out.add((str(room), str(slot)))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# The checker
# ─────────────────────────────────────────────────────────────────────────────

def check(request: dict, response: dict, *, lenient_availability: bool = False) -> Report:
    r = Report()

    teams = {t["id"]: t for t in request.get("teams", [])}
    judges = {j["id"]: j for j in request.get("judges", [])}
    slots = {s["id"]: s for s in request.get("slots", [])}
    rooms = {rm["id"]: rm for rm in request.get("rooms", [])}

    min_j = request.get("min_judges_per_team", 3)
    max_j = request.get("max_judges_per_team", 5)
    composition = _norm_composition(request.get("judge_composition", []), r)
    blocked = _norm_room_slot_pairs(request.get("blocked_room_slots", []), r, "BLOCKED_SHAPE")
    restrict = set(request.get("restrict_to_room_ids", []) or [])
    locked = request.get("locked_sessions", []) or []
    anchors = request.get("anchors", []) or []
    reserved = set(request.get("reserved_judge_ids", []) or [])

    sessions = response.get("sessions", []) or []
    unscheduled = response.get("unscheduled_teams", []) or []

    r.info("INPUT", "solve inputs",
           teams=len(teams), judges=len(judges), slots=len(slots), rooms=len(rooms),
           locked=len(locked), sessions_returned=len(sessions))

    # ── 0. The solver's own verdict ──────────────────────────────────────────
    if not response.get("success", False):
        r.error("SOLVE_FAILED", "solver reported success=false",
                warnings=response.get("warnings", []))

    # ── 1. Anchoring should be dormant ───────────────────────────────────────
    # Session 6 replaced anchoring with per-session composition. If the caller
    # still populates these, the solver will pin judges to rooms and the result
    # will look like a composition bug.
    if anchors:
        r.error("ANCHORS_POPULATED",
                "anchors[] is non-empty but panel composition replaced anchoring; "
                "the solver will pin judges to room-days",
                count=len(anchors))
    if reserved:
        r.warn("RESERVED_POPULATED",
               "reserved_judge_ids is non-empty; those judges are excluded from the rotating pool",
               count=len(reserved))

    # ── 2. Every team scheduled exactly once ─────────────────────────────────
    per_team = Counter(s["team_id"] for s in sessions)

    missing = sorted(set(teams) - set(per_team) - set(unscheduled))
    if missing:
        r.error("TEAM_MISSING",
                "teams neither scheduled nor listed as unscheduled",
                count=len(missing), sample=missing[:5])

    if unscheduled:
        r.error("TEAM_UNSCHEDULED",
                "solver could not place these teams",
                count=len(unscheduled), sample=list(unscheduled)[:5])

    dupes = sorted(t for t, n in per_team.items() if n > 1)
    if dupes:
        r.error("TEAM_DOUBLE_BOOKED",
                "teams appear in more than one session",
                count=len(dupes), sample=[(t, per_team[t]) for t in dupes[:5]])

    unknown = sorted(set(per_team) - set(teams))
    if unknown:
        r.error("TEAM_UNKNOWN",
                "scheduled team ids not present in the request",
                count=len(unknown), sample=unknown[:5])

    if len(teams) and not missing and not dupes and not unscheduled:
        r.info("TEAM_COUNT", f"all {len(teams)} teams scheduled exactly once")

    # ── 3. Panel size and composition ────────────────────────────────────────
    for s in sessions:
        tid = s["team_id"]
        jids = s.get("judge_ids", []) or []

        if len(set(jids)) != len(jids):
            r.error("PANEL_DUPLICATE_JUDGE", "same judge twice on one panel",
                    team=tid, judges=jids)

        if len(jids) < min_j:
            r.error("PANEL_TOO_SMALL", "panel below min_judges_per_team",
                    team=tid, got=len(jids), required=min_j)
        if len(jids) > max_j:
            r.error("PANEL_TOO_LARGE", "panel above max_judges_per_team",
                    team=tid, got=len(jids), allowed=max_j)

        unknown_j = [j for j in jids if j not in judges]
        if unknown_j:
            r.error("PANEL_UNKNOWN_JUDGE", "judge id not present in the request",
                    team=tid, judges=unknown_j)
            continue

        if composition:
            tiers = [str(judges[j].get("tier", "")).upper() for j in jids]
            pool = list(tiers)
            for wanted, count in composition:
                for _ in range(count):
                    hit = next((t for t in pool if t in wanted), None)
                    if hit is None:
                        r.error("PANEL_COMPOSITION",
                                "panel does not satisfy the required tier mix",
                                team=tid, required="|".join(sorted(wanted)),
                                panel_tiers=tiers)
                        break
                    pool.remove(hit)

    # ── 4. Nobody and nothing double-booked ──────────────────────────────────
    judge_slot: dict[tuple[str, str], list[str]] = defaultdict(list)
    room_slot: dict[tuple[str, str], list[str]] = defaultdict(list)

    for s in locked:
        for j in s.get("judge_ids", []) or []:
            judge_slot[(j, s["slot_id"])].append(f"LOCKED:{s['team_id']}")
        room_slot[(s["room_id"], s["slot_id"])].append(f"LOCKED:{s['team_id']}")

    for s in sessions:
        for j in s.get("judge_ids", []) or []:
            judge_slot[(j, s["slot_id"])].append(s["team_id"])
        room_slot[(s["room_id"], s["slot_id"])].append(s["team_id"])

    for (j, slot), occupants in judge_slot.items():
        if len(occupants) > 1:
            r.error("JUDGE_DOUBLE_BOOKED",
                    "judge in more than one session in the same slot",
                    judge=judges.get(j, {}).get("name", j), slot=slot, teams=occupants)

    for (room, slot), occupants in room_slot.items():
        if len(occupants) > 1:
            r.error("ROOM_DOUBLE_BOOKED",
                    "room hosting more than one session in the same slot",
                    room=rooms.get(room, {}).get("name", room), slot=slot, teams=occupants)

    # ── 5. Blocked room-slots and room restriction ───────────────────────────
    for s in sessions:
        pair = (s["room_id"], s["slot_id"])
        if pair in blocked:
            r.error("BLOCKED_ROOM_SLOT_USED",
                    "session placed in a room-slot marked unavailable",
                    team=s["team_id"], room=pair[0], slot=pair[1])
        if restrict and s["room_id"] not in restrict:
            r.error("ROOM_NOT_PERMITTED",
                    "session placed outside restrict_to_room_ids",
                    team=s["team_id"], room=s["room_id"])
        if s["room_id"] not in rooms:
            r.error("ROOM_UNKNOWN", "room id not present in the request",
                    team=s["team_id"], room=s["room_id"])
        if s["slot_id"] not in slots:
            r.error("SLOT_UNKNOWN", "slot id not present in the request",
                    team=s["team_id"], slot=s["slot_id"])

    # ── 6. Conflicts of interest ─────────────────────────────────────────────
    # The fairness-critical one. A judge must never score a team they declared
    # a conflict with.
    for s in sessions:
        for j in s.get("judge_ids", []) or []:
            conflicts = set(judges.get(j, {}).get("conflict_team_ids", []) or [])
            if s["team_id"] in conflicts:
                r.error("CONFLICT_VIOLATED",
                        "judge assigned to a team they have a declared conflict with",
                        judge=judges[j].get("name", j), team=s["team_id"])

    # ── 7. Availability ──────────────────────────────────────────────────────
    # Silence means unavailable for judges (deliberately the opposite of rooms).
    for s in sessions:
        for j in s.get("judge_ids", []) or []:
            avail = judges.get(j, {}).get("available_slot_ids", []) or []
            if not avail:
                lvl = r.warn if lenient_availability else r.error
                lvl("AVAILABILITY_EMPTY",
                    "judge assigned but declared no available slots",
                    judge=judges.get(j, {}).get("name", j), slot=s["slot_id"])
            elif s["slot_id"] not in avail:
                r.error("AVAILABILITY_VIOLATED",
                        "judge assigned to a slot they are not available for",
                        judge=judges[j].get("name", j), slot=s["slot_id"])

    # ── 8. Session budget ────────────────────────────────────────────────────
    load = Counter()
    for s in locked:
        for j in s.get("judge_ids", []) or []:
            load[j] += 1
    for s in sessions:
        for j in s.get("judge_ids", []) or []:
            load[j] += 1

    for j, n in load.items():
        cap = judges.get(j, {}).get("max_sessions", 10)
        if n > cap:
            r.error("MAX_SESSIONS_EXCEEDED", "judge over max_sessions",
                    judge=judges.get(j, {}).get("name", j), assigned=n, cap=cap)

    # ── 9. The silent-exclusion check ────────────────────────────────────────
    # This is the one that would have caught the PM/UTC bug and would catch the
    # judgeTier-defaults-to-L1 bug: a judge who is available but never used.
    for jid, j in judges.items():
        if load.get(jid, 0) == 0:
            has_avail = bool(j.get("available_slot_ids"))
            r.warn("JUDGE_UNUSED",
                   "judge in the pool was never assigned to any session",
                   judge=j.get("name", jid), tier=j.get("tier"),
                   declared_availability=len(j.get("available_slot_ids") or []),
                   likely_cause=("no availability" if not has_avail else "tier or capacity"))

    tier_used = Counter(judges[j].get("tier") for j in load if j in judges)
    tier_pool = Counter(j.get("tier") for j in judges.values())
    r.info("TIER_UTILISATION", "judges used by tier",
           used=dict(tier_used), pool=dict(tier_pool))

    # ── 10. Standby judges should be used last ───────────────────────────────
    standby_load = [load.get(j, 0) for j, v in judges.items() if v.get("is_standby")]
    regular_load = [load.get(j, 0) for j, v in judges.items() if not v.get("is_standby")]
    if standby_load and regular_load:
        if min(standby_load) > 0 and min(regular_load) == 0:
            r.warn("STANDBY_USED_EARLY",
                   "standby judges are loaded while regular judges sit idle",
                   standby=standby_load, regular_min=min(regular_load))

    # ── 11. Load fairness ────────────────────────────────────────────────────
    if load:
        spread = max(load.values()) - min(load.values())
        r.info("LOAD", "sessions per assigned judge",
               min=min(load.values()), max=max(load.values()), spread=spread)
        if spread > 10:
            r.warn("LOAD_UNEVEN", "wide spread in sessions per judge", spread=spread)

    # ── 12. Denormalised fields agree with ids ───────────────────────────────
    # SessionAssignment carries names and times alongside ids. If they drift,
    # exports and the judge portal show something different to the schedule.
    for s in sessions:
        t = teams.get(s["team_id"])
        if t and s.get("team_name") not in (None, t["name"]):
            r.error("DENORM_TEAM_NAME", "team_name does not match the team id",
                    team=s["team_id"], got=s.get("team_name"), expected=t["name"])
        rm = rooms.get(s["room_id"])
        if rm and s.get("room_name") not in (None, rm["name"]):
            r.error("DENORM_ROOM_NAME", "room_name does not match the room id",
                    room=s["room_id"], got=s.get("room_name"), expected=rm["name"])
        sl = slots.get(s["slot_id"])
        if sl:
            for resp_key, req_key in (("slot_date", "date"),
                                      ("slot_start", "start_time"),
                                      ("slot_end", "end_time")):
                if s.get(resp_key) not in (None, sl[req_key]):
                    r.error("DENORM_SLOT", f"{resp_key} does not match the slot id",
                            slot=s["slot_id"], got=s.get(resp_key), expected=sl[req_key])
        names = s.get("judge_names") or []
        ids = s.get("judge_ids") or []
        if names and len(names) != len(ids):
            r.error("DENORM_JUDGE_NAMES", "judge_names and judge_ids differ in length",
                    team=s["team_id"], ids=len(ids), names=len(names))
        elif names:
            for jid, nm in zip(ids, names):
                if jid in judges and judges[jid]["name"] != nm:
                    r.error("DENORM_JUDGE_NAME", "judge_name does not match the judge id",
                            judge=jid, got=nm, expected=judges[jid]["name"])

    # ── 13. Clustering ───────────────────────────────────────────────────────
    # cluster defaults to False and no test covers the default (surviving mutant
    # at models.py:89). Report what actually happened either way.
    slot_order = {s["id"]: i for i, s in enumerate(
        sorted(slots.values(), key=lambda x: (x["date"], x["start_time"])))}
    if slots and sessions:
        idxs = sorted(slot_order.get(s["slot_id"], -1) for s in sessions)
        by_day = defaultdict(list)
        for s in sessions:
            sl = slots.get(s["slot_id"])
            if sl:
                by_day[sl["date"]].append(s["team_id"])
        r.info("SPREAD", "sessions per day",
               days={d: len(v) for d, v in sorted(by_day.items())})
        if request.get("cluster"):
            r.info("CLUSTER", "cluster=true requested; verify contiguity within each day",
                   slot_index_min=min(idxs), slot_index_max=max(idxs))

    return r


# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("request", help="ScheduleRequest JSON")
    p.add_argument("response", help="ScheduleResponse JSON")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    p.add_argument("--quiet", action="store_true", help="errors and warnings only")
    p.add_argument("--lenient-availability", action="store_true",
                   help="treat an empty available_slot_ids as unknown rather than unavailable")
    args = p.parse_args()

    try:
        with open(args.request) as f:
            request = json.load(f)
        with open(args.response) as f:
            response = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"could not read input: {e}", file=sys.stderr)
        return 2

    report = check(request, response, lenient_availability=args.lenient_availability)

    if args.json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        for f in report.findings:
            if args.quiet and f.level == INFO:
                continue
            print(f)
        print()
        verdict = "LEGAL" if report.ok else "ILLEGAL"
        print(f"{verdict} — {len(report.errors)} errors, {len(report.warnings)} warnings")

    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
