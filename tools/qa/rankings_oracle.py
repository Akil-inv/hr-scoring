#!/usr/bin/env python3
"""
Rankings oracle for HackJudge.

An independent second implementation of calculateRankings, in a different
language, reading Postgres with raw SQL and no Prisma. Its only job is to
disagree with rankings.service.ts when rankings.service.ts is wrong.

    export DATABASE_URL=postgresql://user:pass@host:5432/hackjudge
    python rankings_oracle.py --event <event-uuid>
    python rankings_oracle.py --event <uuid> --track <uuid>
    python rankings_oracle.py --event <uuid> --explain <team-uuid>

Aggregation, per ranking_results.aggregation_method = 'criterion_average_sum':
    for each leaf criterion: mean of that criterion's scores across counted
    scorecards; team score = sum of those means.
Tie-break: aggregated score, then highest single criterion mean, then judge count.

Exit codes:
    0  oracle and stored rankings agree (or --no-compare)
    1  they disagree, or a precondition failed
    2  bad input / no connection
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from decimal import Decimal

try:
    import psycopg
    from psycopg.rows import dict_row
    _PG3 = True
except ImportError:  # pragma: no cover
    try:
        import psycopg2 as psycopg
        from psycopg2.extras import RealDictCursor
        _PG3 = False
    except ImportError:
        print("pip install 'psycopg[binary]'   (or psycopg2-binary)", file=sys.stderr)
        raise SystemExit(2)

# Which scorecard statuses count towards a ranking.
#
# RESUBMITTED is included here deliberately. A judge who reopened and
# resubmitted has produced a final score; excluding it silently drops a judge
# from the average while the session still reads as complete. If
# rankings.service.ts does not include it, this oracle will disagree — and the
# oracle is right.
DEFAULT_STATUSES = ["SUBMITTED", "LOCKED", "RESUBMITTED"]


def connect(url: str):
    if _PG3:
        return psycopg.connect(url, row_factory=dict_row)
    return psycopg.connect(url, cursor_factory=RealDictCursor)


def q(conn, sql: str, params: tuple = ()) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return list(cur.fetchall())


# ─────────────────────────────────────────────────────────────────────────────
# Preconditions — the things that make a ranking meaningless before you even
# compute it. Each corresponds to a real defect found in this schema.
# ─────────────────────────────────────────────────────────────────────────────

def preconditions(conn, event_id: str, statuses: list[str]) -> list[str]:
    problems: list[str] = []

    templates = q(conn, """
        SELECT id, name, status, created_at
        FROM scoring_templates WHERE event_id = %s ORDER BY created_at
    """, (event_id,))
    if not templates:
        problems.append("FATAL: no scoring template for this event")
        return problems
    if len(templates) > 1:
        names = ", ".join(f"{t['name']}({t['status']})" for t in templates)
        problems.append(
            f"FATAL: {len(templates)} scoring templates exist — findFirst() with no "
            f"orderBy returns an arbitrary one, so rankings are nondeterministic "
            f"between runs. Templates: {names}")

    tpl = templates[0]["id"]

    leaves = q(conn, """
        SELECT c.id, c.name, c.max_score, c.weight
        FROM scoring_criteria c
        WHERE c.template_id = %s
          AND NOT EXISTS (SELECT 1 FROM scoring_criteria k WHERE k.parent_id = c.id)
        ORDER BY c.display_order
    """, (tpl,))
    if not leaves:
        problems.append(
            "FATAL: template has no leaf criteria — every team scores 0 and the "
            "ranking is meaningless (no guard exists for this in the service)")

    dupes = q(conn, """
        SELECT team_id, count(*) AS n
        FROM ranking_results
        WHERE event_id = %s AND track_id IS NULL
        GROUP BY team_id HAVING count(*) > 1
    """, (event_id,))
    if dupes:
        problems.append(
            f"WARNING: {len(dupes)} teams have duplicate rows in ranking_results for "
            f"the overall ranking. @@unique([eventId, trackId, teamId]) does not hold "
            f"when track_id IS NULL, because NULL != NULL in a Postgres unique index. "
            f"Every recalculation inserts a fresh set instead of conflicting.")

    stray = q(conn, """
        SELECT status, count(*) AS n
        FROM scorecards
        WHERE event_id = %s AND status <> ALL(%s) AND status <> 'NOT_STARTED'
        GROUP BY status
    """, (event_id, statuses))
    for row in stray:
        problems.append(
            f"WARNING: {row['n']} scorecards in status {row['status']} are excluded "
            f"from the ranking. Confirm that is intended.")

    nulls = q(conn, """
        SELECT count(*) AS n
        FROM criterion_scores cs
        JOIN scorecards s ON s.id = cs.scorecard_id
        WHERE s.event_id = %s AND s.status = ANY(%s) AND cs.score IS NULL
    """, (event_id, statuses))
    if nulls and nulls[0]["n"]:
        problems.append(
            f"WARNING: {nulls[0]['n']} criterion scores are NULL on counted scorecards. "
            f"AVG() skips them, so those criteria are averaged over fewer judges than "
            f"the rest.")

    mismatch = q(conn, """
        SELECT s.id, s.total_score, sum(cs.score) AS computed
        FROM scorecards s
        JOIN criterion_scores cs ON cs.scorecard_id = s.id
        WHERE s.event_id = %s AND s.status = ANY(%s) AND s.total_score IS NOT NULL
        GROUP BY s.id, s.total_score
        HAVING s.total_score <> sum(cs.score)
    """, (event_id, statuses))
    if mismatch:
        problems.append(
            f"WARNING: {len(mismatch)} scorecards where total_score disagrees with the "
            f"sum of their criterion scores. The portal and the ranking are reading "
            f"different numbers.")

    orphan = q(conn, """
        SELECT count(*) AS n
        FROM criterion_scores cs
        JOIN scorecards s ON s.id = cs.scorecard_id
        JOIN scoring_criteria c ON c.id = cs.criterion_id
        WHERE s.event_id = %s AND c.template_id <> %s
    """, (event_id, tpl))
    if orphan and orphan[0]["n"]:
        problems.append(
            f"WARNING: {orphan[0]['n']} criterion scores point at criteria from a "
            f"different template. Those scores are invisible to the ranking.")

    return problems


# ─────────────────────────────────────────────────────────────────────────────

def compute(conn, event_id: str, track_id: str | None,
            statuses: list[str], weighted: bool) -> list[dict]:
    tpl = q(conn, "SELECT id FROM scoring_templates WHERE event_id = %s "
                  "ORDER BY created_at LIMIT 1", (event_id,))[0]["id"]

    rows = q(conn, """
        WITH leaves AS (
            SELECT c.id, c.name, c.weight
            FROM scoring_criteria c
            WHERE c.template_id = %s
              AND NOT EXISTS (SELECT 1 FROM scoring_criteria k WHERE k.parent_id = c.id)
        ),
        counted AS (
            SELECT s.id, s.team_id, s.judge_id
            FROM scorecards s
            JOIN teams t  ON t.id = s.team_id
            JOIN judges j ON j.id = s.judge_id
            WHERE s.event_id = %s
              AND s.status = ANY(%s)
              AND t.deleted_at IS NULL
              AND j.deleted_at IS NULL
              AND (%s::uuid IS NULL OR t.track_id = %s::uuid)
        )
        SELECT t.id            AS team_id,
               t.name          AS team_name,
               l.id            AS criterion_id,
               l.name          AS criterion_name,
               l.weight        AS weight,
               avg(cs.score)   AS mean,
               count(cs.score) AS n_scores
        FROM teams t
        JOIN counted c           ON c.team_id = t.id
        JOIN criterion_scores cs ON cs.scorecard_id = c.id
        JOIN leaves l            ON l.id = cs.criterion_id
        WHERE t.event_id = %s AND t.deleted_at IS NULL
        GROUP BY t.id, t.name, l.id, l.name, l.weight
    """, (tpl, event_id, statuses, track_id, track_id, event_id))

    judge_counts = {r["team_id"]: r["n"] for r in q(conn, """
        SELECT s.team_id, count(DISTINCT s.judge_id) AS n
        FROM scorecards s
        JOIN judges j ON j.id = s.judge_id
        WHERE s.event_id = %s AND s.status = ANY(%s) AND j.deleted_at IS NULL
        GROUP BY s.team_id
    """, (event_id, statuses))}

    teams: dict[str, dict] = {}
    for row in rows:
        t = teams.setdefault(row["team_id"], {
            "team_id": row["team_id"], "team_name": row["team_name"],
            "criteria": [], "score": Decimal(0), "best_criterion_mean": Decimal(0),
        })
        mean = Decimal(str(row["mean"]))
        contrib = mean * Decimal(str(row["weight"])) if weighted else mean
        t["criteria"].append({
            "name": row["criterion_name"], "mean": mean,
            "weight": Decimal(str(row["weight"])), "contribution": contrib,
            "n_scores": row["n_scores"],
        })
        t["score"] += contrib
        t["best_criterion_mean"] = max(t["best_criterion_mean"], mean)

    for t in teams.values():
        t["judge_count"] = judge_counts.get(t["team_id"], 0)
        t["criteria"].sort(key=lambda c: c["name"])

    ordered = sorted(teams.values(),
                     key=lambda t: (t["score"], t["best_criterion_mean"], t["judge_count"]),
                     reverse=True)
    for i, t in enumerate(ordered, 1):
        t["rank"] = i
    return ordered


def compare(conn, event_id: str, track_id: str | None, oracle: list[dict]) -> list[str]:
    stored = q(conn, """
        SELECT r.team_id, t.name AS team_name, r.rank_position,
               r.aggregated_score, r.judge_count, r.status
        FROM ranking_results r
        JOIN teams t ON t.id = r.team_id
        WHERE r.event_id = %s AND r.track_id IS NOT DISTINCT FROM %s::uuid
        ORDER BY r.rank_position
    """, (event_id, track_id))

    if not stored:
        return ["no rows in ranking_results — calculateRankings has not been run "
                "for this scope, so there is nothing to compare against"]

    by_team = {r["team_id"]: r for r in stored}
    diffs: list[str] = []

    for t in oracle:
        s = by_team.pop(t["team_id"], None)
        if s is None:
            diffs.append(f"MISSING  {t['team_name']}: oracle ranks it {t['rank']} "
                         f"but there is no stored row")
            continue
        if abs(Decimal(str(s["aggregated_score"])) - t["score"]) > Decimal("0.01"):
            diffs.append(f"SCORE    {t['team_name']}: stored {s['aggregated_score']} "
                         f"vs oracle {t['score']:.2f}")
        if s["rank_position"] != t["rank"]:
            diffs.append(f"RANK     {t['team_name']}: stored #{s['rank_position']} "
                         f"vs oracle #{t['rank']}")
        if s["judge_count"] != t["judge_count"]:
            diffs.append(f"JUDGES   {t['team_name']}: stored {s['judge_count']} "
                         f"vs oracle {t['judge_count']}")

    for leftover in by_team.values():
        diffs.append(f"EXTRA    {leftover['team_name']}: stored at "
                     f"#{leftover['rank_position']} but the oracle does not rank it "
                     f"(deleted team, or a stale row from an earlier run)")

    return diffs


def explain(oracle: list[dict], team_id: str) -> None:
    t = next((x for x in oracle if x["team_id"] == team_id), None)
    if not t:
        print(f"team {team_id} not in the oracle ranking")
        return
    print(f"\n{t['team_name']}  —  rank #{t['rank']}\n")
    print(f"  {'criterion':<38} {'mean':>7} {'weight':>7} {'n':>4} {'contrib':>9}")
    print("  " + "-" * 68)
    for c in t["criteria"]:
        print(f"  {c['name'][:38]:<38} {c['mean']:>7.2f} {c['weight']:>7} "
              f"{c['n_scores']:>4} {c['contribution']:>9.2f}")
    print("  " + "-" * 68)
    print(f"  {'TOTAL':<38} {'':>7} {'':>7} {'':>4} {t['score']:>9.2f}")
    print(f"\n  judges counted: {t['judge_count']}")
    print(f"  best single criterion mean (tie-break 1): {t['best_criterion_mean']:.2f}\n")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--event", required=True)
    p.add_argument("--track", default=None, help="track uuid; omit for overall")
    p.add_argument("--statuses", default=",".join(DEFAULT_STATUSES))
    p.add_argument("--weighted", action="store_true",
                   help="multiply each criterion mean by its weight")
    p.add_argument("--explain", metavar="TEAM_ID", help="show the full workings")
    p.add_argument("--no-compare", action="store_true")
    p.add_argument("--top", type=int, default=15)
    args = p.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("set DATABASE_URL", file=sys.stderr)
        return 2

    statuses = [s.strip() for s in args.statuses.split(",")]
    failed = False

    with connect(url) as conn:
        print(f"event {args.event}  track {args.track or '(overall)'}  "
              f"statuses {','.join(statuses)}"
              f"{'  weighted' if args.weighted else ''}\n")

        problems = preconditions(conn, args.event, statuses)
        for pr in problems:
            print(f"  {pr}")
            if pr.startswith("FATAL"):
                failed = True
        if problems:
            print()
        if failed:
            return 1

        oracle = compute(conn, args.event, args.track, statuses, args.weighted)

        if args.explain:
            explain(oracle, args.explain)
            return 0

        print(f"  {'#':>3}  {'team':<40} {'score':>8} {'judges':>7}")
        print("  " + "-" * 62)
        for t in oracle[:args.top]:
            print(f"  {t['rank']:>3}  {t['team_name'][:40]:<40} "
                  f"{t['score']:>8.2f} {t['judge_count']:>7}")
        if len(oracle) > args.top:
            print(f"  ... {len(oracle) - args.top} more")
        print()

        if args.no_compare:
            return 0

        diffs = compare(conn, args.event, args.track, oracle)
        if diffs:
            print("  DISAGREEMENT with ranking_results:\n")
            for d in diffs:
                print(f"    {d}")
            print()
            return 1

        print(f"  AGREES with ranking_results across {len(oracle)} teams\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())
