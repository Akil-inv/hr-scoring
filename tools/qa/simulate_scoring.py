#!/usr/bin/env python3
"""
Scoring simulator for HackJudge.

Writes a designed set of scorecards whose correct ranking is known in advance,
then checks that calculateRankings produces it. The expectations are derived
from the documented rule (per-criterion mean across submitted scorecards,
summed; tie-break on highest single criterion mean, then judge count) — not
from the service's own output, so a wrong service cannot mark its own homework.

    export DATABASE_URL=postgresql://...
    python3 simulate_scoring.py --event <uuid> --apply     # write the fixture
    #   ... run "Calculate rankings" in the app ...
    python3 simulate_scoring.py --event <uuid> --verify    # check the result
    python3 simulate_scoring.py --event <uuid> --reset     # clear the fixture

Eight teams, each probing one behaviour:

    TOP     3 judges, high              baseline ordering
    BREAK   2 score, 3rd on break       break excluded, judge_count = 2
    RESUB   2 low + 1 RESUBMITTED high  whether RESUBMITTED is counted
    TIE_B   equals TIE_A, one peak      tie-break 1: best criterion mean
    TIE_A   equals TIE_B, flat          ranks below TIE_B
    TIE_C   3 judges, flat              tie-break 2 reference
    TIE_D   same scores, 3rd is DRAFT   draft excluded; loses on judge count
    BOTTOM  3 judges, low               last

The tie-breaks are constructed so that every judge on a team gives identical
scores. Dropping a judge then changes the judge count without moving any mean,
so the aggregate tie survives and only the tie-break can separate the pair.

Exit codes: 0 pass, 1 fail, 2 bad input.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from decimal import Decimal

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    print("pip install 'psycopg[binary]'", file=sys.stderr)
    raise SystemExit(2)


# ─────────────────────────────────────────────────────────────────────────────
# Fixture definition
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class Scenario:
    key: str
    # Fraction of each criterion's max_score that judges 1 and 2 award.
    base: float
    # Judge 3: (fraction, scorecard status). None means no scorecard at all.
    third: tuple[float, str] | None
    # Judge 3 is marked on_break on the session_judges row.
    third_on_break: bool = False
    # Move `peak` points onto the highest-max criterion and off the second,
    # leaving the total unchanged but raising the best single criterion mean.
    peak: int = 0
    note: str = ""


SCENARIOS = [
    Scenario("TOP",    0.95, (0.95, "SUBMITTED"),
             note="baseline — should rank first"),
    Scenario("BREAK",  0.85, None, third_on_break=True,
             note="third judge on break; averages over 2, judge_count 2"),
    Scenario("RESUB",  0.70, (0.90, "RESUBMITTED"),
             note="if RESUBMITTED counts, score rises; if excluded, it does not"),
    Scenario("TIE_B",  0.65, (0.65, "SUBMITTED"), peak=2,
             note="same total as TIE_A, higher single criterion — wins tie-break 1"),
    Scenario("TIE_A",  0.65, (0.65, "SUBMITTED"),
             note="same total as TIE_B, flat — loses tie-break 1"),
    Scenario("TIE_C",  0.55, (0.55, "SUBMITTED"),
             note="same total as TIE_D, 3 judges — wins tie-break 2"),
    Scenario("TIE_D",  0.55, (0.10, "DRAFT"),
             note="draft must be excluded; ties TIE_C, loses on judge count"),
    Scenario("BOTTOM", 0.20, (0.20, "SUBMITTED"),
             note="baseline — should rank last"),
]


@dataclass
class Expected:
    key: str
    team_id: str
    team_name: str
    score: Decimal
    judge_count: int
    best_mean: Decimal
    rank: int = 0
    note: str = ""
    per_criterion: list = field(default_factory=list)


def connect(url: str):
    return psycopg.connect(url, row_factory=dict_row)


def q(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall()) if cur.description else []


# ─────────────────────────────────────────────────────────────────────────────

def load_criteria(conn, event_id: str) -> list[dict]:
    tpls = q(conn, "SELECT id FROM scoring_templates WHERE event_id = %s "
                   "ORDER BY created_at", (event_id,))
    if not tpls:
        raise SystemExit("no scoring template for this event")
    if len(tpls) > 1:
        raise SystemExit(f"{len(tpls)} scoring templates — resolve that first, "
                         "the service picks one arbitrarily")

    crit = q(conn, """
        SELECT c.id, c.name, c.max_score, c.weight, c.display_order
        FROM scoring_criteria c
        WHERE c.template_id = %s
          AND NOT EXISTS (SELECT 1 FROM scoring_criteria k WHERE k.parent_id = c.id)
        ORDER BY c.display_order, c.name
    """, (tpls[0]["id"],))
    if not crit:
        raise SystemExit("template has no leaf criteria")
    return crit


def pick_teams(conn, event_id: str, n: int) -> list[dict]:
    """Teams with a session of exactly three judges and three scorecards."""
    rows = q(conn, """
        SELECT t.id AS team_id, t.name AS team_name, s.id AS session_id
        FROM teams t
        JOIN judging_sessions s ON s.team_id = t.id
        WHERE t.event_id = %s AND t.deleted_at IS NULL
          AND (SELECT count(*) FROM session_judges sj WHERE sj.session_id = s.id) = 3
          AND (SELECT count(*) FROM scorecards sc WHERE sc.session_id = s.id) = 3
        ORDER BY t.name
        LIMIT %s
    """, (event_id, n))
    if len(rows) < n:
        raise SystemExit(
            f"only {len(rows)} teams have a 3-judge session with 3 scorecards; "
            f"need {n}. Generate and save a schedule first.")
    return rows


def scores_for(scenario: Scenario, criteria: list[dict], fraction: float) -> dict[str, int]:
    """Raw score per criterion for one judge."""
    out = {c["id"]: int(round(fraction * c["max_score"])) for c in criteria}
    if scenario.peak:
        # Highest-max criterion gains, the next loses, so the total is unchanged
        # but the best single criterion mean rises.
        ordered = sorted(criteria, key=lambda c: -c["max_score"])
        hi, lo = ordered[0], ordered[1]
        if out[hi["id"]] + scenario.peak <= hi["max_score"] and \
           out[lo["id"]] - scenario.peak >= 0:
            out[hi["id"]] += scenario.peak
            out[lo["id"]] -= scenario.peak
        else:
            raise SystemExit("peak adjustment does not fit inside the criterion "
                             "ranges; lower Scenario.peak")
    return out


def build_expectations(criteria: list[dict], teams: list[dict]) -> list[Expected]:
    exp: list[Expected] = []

    for sc, team in zip(SCENARIOS, teams):
        # Which scorecards count towards the mean.
        counting: list[dict[str, int]] = [
            scores_for(sc, criteria, sc.base),
            scores_for(sc, criteria, sc.base),
        ]
        judges = 2
        if sc.third and sc.third[1] in ("SUBMITTED", "LOCKED", "RESUBMITTED"):
            counting.append(scores_for(sc, criteria, sc.third[0]))
            judges = 3

        # ROUND-1: each criterion mean is rounded to 2dp, then the rounded
        # means are summed, then rounded again. Summing exact means and
        # rounding once gives a different answer — 0.01 on a 9-criterion
        # rubric, 0.02 on an 11-criterion one — and the difference looks like
        # a defect when it is only a different arithmetic order.
        total = Decimal(0)
        best = Decimal(0)
        per_crit = []
        for c in criteria:
            vals = [Decimal(s[c["id"]]) for s in counting]
            mean = (sum(vals) / Decimal(len(vals))).quantize(Decimal("0.01"))
            total += mean
            best = max(best, mean)
            per_crit.append((c["name"], mean, len(vals)))

        exp.append(Expected(
            key=sc.key, team_id=team["team_id"], team_name=team["team_name"],
            score=total.quantize(Decimal("0.01")), judge_count=judges,
            best_mean=best, note=sc.note, per_criterion=per_crit,
        ))

    ordered = sorted(exp, key=lambda e: (e.score, e.best_mean, e.judge_count),
                     reverse=True)
    for i, e in enumerate(ordered, 1):
        e.rank = i
    return ordered


# ─────────────────────────────────────────────────────────────────────────────

def apply_fixture(conn, event_id: str, criteria, teams, dry: bool) -> None:
    for sc, team in zip(SCENARIOS, teams):
        cards = q(conn, """
            SELECT sc.id, sc.judge_id
            FROM scorecards sc
            WHERE sc.session_id = %s
            ORDER BY sc.judge_id
        """, (team["session_id"],))

        plan = [(cards[0], sc.base, "SUBMITTED"),
                (cards[1], sc.base, "SUBMITTED")]
        if sc.third:
            plan.append((cards[2], sc.third[0], sc.third[1]))
        else:
            plan.append((cards[2], None, "NOT_STARTED"))

        for card, fraction, status in plan:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM criterion_scores WHERE scorecard_id = %s",
                            (card["id"],))
                if fraction is None:
                    cur.execute("""
                        UPDATE scorecards SET status = %s, total_score = NULL,
                               submitted_at = NULL, updated_at = now()
                        WHERE id = %s
                    """, (status, card["id"]))
                    continue

                vals = scores_for(sc, criteria, fraction)
                for cid, v in vals.items():
                    cur.execute("""
                        INSERT INTO criterion_scores
                          (id, scorecard_id, criterion_id, score, created_at, updated_at)
                        VALUES (gen_random_uuid(), %s, %s, %s, now(), now())
                    """, (card["id"], cid, v))
                cur.execute("""
                    UPDATE scorecards
                    SET status = %s, total_score = %s,
                        submitted_at = CASE WHEN %s IN ('SUBMITTED','LOCKED','RESUBMITTED')
                                            THEN now() ELSE NULL END,
                        updated_at = now()
                    WHERE id = %s
                """, (status, sum(vals.values()), status, card["id"]))

        with conn.cursor() as cur:
            cur.execute("UPDATE session_judges SET on_break = %s, break_at = "
                        "CASE WHEN %s THEN now() ELSE NULL END "
                        "WHERE session_id = %s AND judge_id = %s",
                        (sc.third_on_break, sc.third_on_break,
                         team["session_id"], cards[2]["judge_id"]))

    if dry:
        conn.rollback()
        print("dry run — rolled back\n")
    else:
        conn.commit()


def reset_fixture(conn, event_id: str, teams) -> None:
    for team in teams:
        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM criterion_scores
                WHERE scorecard_id IN (SELECT id FROM scorecards WHERE session_id = %s)
            """, (team["session_id"],))
            cur.execute("""
                UPDATE scorecards SET status = 'NOT_STARTED', total_score = NULL,
                       submitted_at = NULL, updated_at = now()
                WHERE session_id = %s
            """, (team["session_id"],))
            cur.execute("UPDATE session_judges SET on_break = false, break_at = NULL "
                        "WHERE session_id = %s", (team["session_id"],))
    conn.commit()
    print(f"cleared the fixture on {len(teams)} teams")


# ─────────────────────────────────────────────────────────────────────────────

def print_expected(exp: list[Expected]) -> None:
    print(f"  {'#':>3}  {'scenario':<8} {'team':<30} {'score':>8} {'judges':>7}  note")
    print("  " + "-" * 100)
    for e in exp:
        print(f"  {e.rank:>3}  {e.key:<8} {e.team_name[:30]:<30} "
              f"{e.score:>8} {e.judge_count:>7}  {e.note}")
    print()


def verify(conn, event_id: str, exp: list[Expected]) -> int:
    stored = {r["team_id"]: r for r in q(conn, """
        SELECT r.team_id, r.rank_position, r.aggregated_score, r.judge_count,
               r.tied
        FROM ranking_results r
        WHERE r.event_id = %s AND r.track_id IS NULL
    """, (event_id,))}

    if not stored:
        print("  no rows in ranking_results — run Calculate rankings in the app first\n")
        return 1

    dupes = q(conn, """
        SELECT team_id, count(*) AS n FROM ranking_results
        WHERE event_id = %s AND track_id IS NULL
        GROUP BY team_id HAVING count(*) > 1
    """, (event_id,))
    if dupes:
        print(f"  WARNING: {len(dupes)} teams have duplicate ranking_results rows "
              f"(the unique constraint does not hold when track_id IS NULL)\n")

    # Only our fixture teams are compared; other teams may also be ranked.
    fixture_ids = [e.team_id for e in exp]
    present = [e for e in exp if e.team_id in stored]
    if len(present) < len(exp):
        missing = [e.key for e in exp if e.team_id not in stored]
        print(f"  {len(missing)} fixture team(s) absent from ranking_results: "
              f"{', '.join(missing)}")

    # Ordering is asserted on the *stored* rank_position, and rank_position must
    # be distinct wherever a tie-break separated two teams.
    #
    # The earlier version of this check sorted by rank_position alone. Tied
    # teams shared a position, so Python's stable sort preserved the expected
    # order regardless of what the service had done — and the check passed
    # whether the tie-break survived being written down or not. That is exactly
    # the defect it was supposed to catch (RANK-4).
    actual_order = sorted(
        present, key=lambda e: (stored[e.team_id]["rank_position"], e.team_id)
    )
    expected_order = sorted(present, key=lambda e: e.rank)

    fails: list[str] = []

    print(f"  {'scenario':<8} {'expected':>10} {'actual':>10}  {'judges e/a':>11}  result")
    print("  " + "-" * 62)
    for e in expected_order:
        s = stored[e.team_id]
        got = Decimal(str(s["aggregated_score"]))
        ok_score = abs(got - e.score) <= Decimal("0.01")
        ok_judges = s["judge_count"] == e.judge_count
        mark = "ok" if (ok_score and ok_judges) else "FAIL"
        if not ok_score:
            fails.append(f"{e.key}: score expected {e.score}, got {got}")
        if not ok_judges:
            fails.append(f"{e.key}: judge_count expected {e.judge_count}, "
                         f"got {s['judge_count']}")
        print(f"  {e.key:<8} {e.score:>10} {got:>10}  "
              f"{e.judge_count:>5}/{s['judge_count']:<5}  {mark}")
    print()

    exp_keys = [e.key for e in expected_order]
    act_keys = [e.key for e in actual_order]
    if exp_keys != act_keys:
        fails.append(f"order expected {' > '.join(exp_keys)}, "
                     f"got {' > '.join(act_keys)}")

    # RANK-4. Every pair the design expects to be separated must hold distinct
    # rank positions. Equal positions mean the tie-break ran and was discarded:
    # the order is then whatever Postgres returns and can differ between reads.
    for a, b in zip(expected_order, expected_order[1:]):
        pa = stored[a.team_id]["rank_position"]
        pb = stored[b.team_id]["rank_position"]
        if pa == pb:
            fails.append(
                f"RANK-4: {a.key} and {b.key} share rank_position {pa}. The "
                f"tie-break separated them in memory but the stored position "
                f"did not record it, so the displayed order is arbitrary.")

    # None of the fixture pairs is a true tie: TIE_B/TIE_A differ on best
    # criterion mean, TIE_C/TIE_D on judge count. So nothing should be flagged.
    for e in present:
        if stored[e.team_id].get("tied"):
            fails.append(
                f"{e.key} is flagged tied, but the design expects a tie-break "
                f"to have separated it.")

    # Named intent checks, so a failure says what broke rather than which number moved.
    pos = {e.key: i for i, e in enumerate(actual_order)}
    if "TIE_B" in pos and "TIE_A" in pos and pos["TIE_B"] > pos["TIE_A"]:
        fails.append("tie-break 1 (highest single criterion mean) not applied: "
                     "TIE_A ranked above TIE_B despite an equal total")
    if "TIE_C" in pos and "TIE_D" in pos and pos["TIE_C"] > pos["TIE_D"]:
        fails.append("tie-break 2 (judge count) not applied: TIE_D ranked above "
                     "TIE_C despite fewer judges on an equal total")

    resub = next((e for e in present if e.key == "RESUB"), None)
    if resub:
        got = Decimal(str(stored[resub.team_id]["aggregated_score"]))
        # Only a score *below* expectation indicates exclusion: RESUB's third
        # judge scores higher than the other two, so dropping that card lowers
        # the average. A score above expectation is arithmetic, not exclusion —
        # claiming otherwise from a difference in either direction is how a
        # diagnostic ends up confidently wrong.
        if got < resub.score - Decimal("0.05"):
            fails.append(
                f"RESUBMITTED scorecards appear to be excluded from rankings "
                f"(expected {resub.score} with it counted, got {got}). A judge who "
                f"reopens and resubmits is silently dropped from the average.")

    tie_d = next((e for e in present if e.key == "TIE_D"), None)
    if tie_d:
        got = Decimal(str(stored[tie_d.team_id]["aggregated_score"]))
        if got < tie_d.score - Decimal("0.01"):
            fails.append("DRAFT scorecard appears to be counted: TIE_D scored "
                         "lower than its two submitted scorecards alone would give")

    if fails:
        print("  FAILURES\n")
        for f in fails:
            print(f"    - {f}")
        print()
        return 1

    print(f"  PASS — rankings match the designed expectation across "
          f"{len(present)} teams\n")
    return 0


# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--event", required=True)
    p.add_argument("--apply", action="store_true", help="write the fixture")
    p.add_argument("--verify", action="store_true", help="check ranking_results")
    p.add_argument("--reset", action="store_true", help="clear the fixture")
    p.add_argument("--dry-run", action="store_true", help="with --apply, roll back")
    p.add_argument("--explain", action="store_true", help="per-criterion workings")
    args = p.parse_args()

    if not (args.apply or args.verify or args.reset):
        p.error("choose one of --apply, --verify, --reset")

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("set DATABASE_URL", file=sys.stderr)
        return 2

    with connect(url) as conn:
        criteria = load_criteria(conn, args.event)
        teams = pick_teams(conn, args.event, len(SCENARIOS))

        print(f"\nevent {args.event}")
        print(f"{len(criteria)} leaf criteria, max total "
              f"{sum(c['max_score'] for c in criteria)}\n")

        exp = build_expectations(criteria, teams)

        if args.reset:
            return reset_fixture(conn, args.event, teams) or 0

        if args.apply:
            apply_fixture(conn, args.event, criteria, teams, args.dry_run)
            print("  fixture written. Expected ranking:\n")
            print_expected(exp)
            if args.explain:
                for e in exp:
                    print(f"  {e.key} — {e.team_name}")
                    for name, mean, n in e.per_criterion:
                        print(f"      {name[:44]:<44} {mean:>7.2f}  over {n} judge(s)")
                    print(f"      {'TOTAL':<44} {e.score:>7}\n")
            print("  Now run Calculate rankings in the app, then --verify.\n")
            return 0

        print("  Expected:\n")
        print_expected(exp)
        print("  Actual:\n")
        return verify(conn, args.event, exp)


if __name__ == "__main__":
    sys.exit(main())
