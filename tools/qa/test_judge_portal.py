#!/usr/bin/env python3
"""
Judge portal write-path test.

Exercises the REST portal the way a judge's browser does — real tokens, real
HTTP, real payloads — then checks the database independently. This is the path
that has drifted from GraphQL twice, and the only one a judge touches live.

    export DATABASE_URL=postgresql://...
    export JUDGE_TOKEN_SALT=...           # only if set in the API's env
    python3 test_judge_portal.py --event <uuid>
    python3 test_judge_portal.py --event <uuid> --base http://localhost:4000

Takes over the sessions of two teams, restores them at the end, and leaves the
database as it found it. Run --cleanup if a crash leaves state behind.

Exit codes: 0 all pass, 1 failures, 2 setup problem.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from decimal import Decimal
from dataclasses import dataclass, field

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    print("pip install 'psycopg[binary]'", file=sys.stderr)
    raise SystemExit(2)


VERSION = "2026-08-21.1 (partial saves must not erase)"

PASS, FAIL, BUG, INFO = "PASS", "FAIL", "BUG ", "INFO"


@dataclass
class Results:
    rows: list = field(default_factory=list)

    def add(self, level, name, detail=""):
        self.rows.append((level, name, detail))
        print(f"  {level}  {name}")
        if detail:
            for line in detail.splitlines():
                print(f"          {line}")

    def ok(self, name, detail=""):
        self.add(PASS, name, detail)

    def fail(self, name, detail=""):
        self.add(FAIL, name, detail)

    def bug(self, name, detail=""):
        self.add(BUG, name, detail)

    def info(self, name, detail=""):
        self.add(INFO, name, detail)

    @property
    def failures(self):
        return [r for r in self.rows if r[0] in (FAIL, BUG)]


def token_for(judge_id, salt: str) -> str:
    # psycopg3 returns uuid.UUID objects, not strings.
    return hashlib.sha256((str(judge_id) + salt).encode()).hexdigest()[:16]


def http(method, url, body=None, expect_error=False):
    """Returns (status, parsed_json_or_text)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw
    except Exception as e:
        if expect_error:
            return 0, str(e)
        raise


def _plain(v):
    """psycopg3 returns uuid.UUID and Decimal objects. Both need to be strings
    or numbers by the time they reach json.dumps or an equality check against a
    value that came back over HTTP."""
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, Decimal):
        return float(v)
    return v


def q(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        if not cur.description:
            return []
        return [{k: _plain(v) for k, v in row.items()} for row in cur.fetchall()]


def ex(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────

def run(conn, base: str, event_id: str, salt: str, r: Results) -> None:
    api = f"{base}/api/judge-portal"

    leaves = q(conn, """
        SELECT c.id, c.name, c.max_score, c.requires_comment
        FROM scoring_criteria c
        JOIN scoring_templates t ON t.id = c.template_id
        WHERE t.event_id = %s
          AND NOT EXISTS (SELECT 1 FROM scoring_criteria k WHERE k.parent_id = c.id)
        ORDER BY c.display_order
    """, (event_id,))
    n_leaves = len(leaves)
    r.info(f"{n_leaves} leaf criteria, max total "
           f"{sum(c['max_score'] for c in leaves)}")

    tpl = q(conn, "SELECT id, status FROM scoring_templates WHERE event_id = %s",
            (event_id,))
    if tpl and tpl[0]["status"] != "ACTIVE":
        r.bug("template is not ACTIVE",
              f"status={tpl[0]['status']}. /score looks up the template with "
              f"status:'ACTIVE' and will find none, so the parent/leaf filter is "
              f"empty and category rows can be scored. /scorecards and rankings "
              f"do not filter on status, so the three disagree.")

    # Two sessions with three judges, and a PS among them for the break test.
    sessions = q(conn, """
        SELECT s.id AS session_id, s.stage, t.name AS team_name, t.id AS team_id
        FROM judging_sessions s
        JOIN teams t ON t.id = s.team_id
        WHERE s.event_id = %s
          AND (SELECT count(*) FROM session_judges sj WHERE sj.session_id = s.id) = 3
        ORDER BY t.name
        LIMIT 2
    """, (event_id,))
    if len(sessions) < 2:
        raise SystemExit("need two 3-judge sessions; generate and save a schedule first")

    s1, s2 = sessions
    original_stages = {s["session_id"]: s["stage"] for s in sessions}

    def judges_on(session_id):
        return q(conn, """
            SELECT j.id, j.name, j.judge_tier, sc.id AS scorecard_id, sc.status
            FROM session_judges sj
            JOIN judges j ON j.id = sj.judge_id
            LEFT JOIN scorecards sc ON sc.session_id = sj.session_id AND sc.judge_id = j.id
            WHERE sj.session_id = %s
            ORDER BY j.judge_tier, j.name
        """, (session_id,))

    js1 = judges_on(s1["session_id"])
    js2 = judges_on(s2["session_id"])
    r.info(f"session 1: {s1['team_name']} — " +
           ", ".join(f"{j['name']}({j['judge_tier']})" for j in js1))

    judge_a = next((j for j in js1 if j["judge_tier"] in ("L2", "L3", "L4")), js1[0])
    judge_ps = next((j for j in js1 if j["judge_tier"] == "PS"), None)
    judge_b = next((j for j in js1 if j["id"] != judge_a["id"]
                    and j["judge_tier"] in ("L2", "L3", "L4")), None)

    tok_a = token_for(judge_a["id"], salt)
    tok_ps = token_for(judge_ps["id"], salt) if judge_ps else None

    # ── 1. Token and schedule fetch ─────────────────────────────────────────
    st, body = http("GET", f"{api}/{tok_a}?event={event_id}")
    if st == 200 and isinstance(body, dict) and body.get("judge", {}).get("id") == judge_a["id"]:
        r.ok("valid token returns this judge's schedule")
    else:
        r.fail("valid token rejected",
               f"status={st}. If JUDGE_TOKEN_SALT differs between this shell and "
               f"the API, every token will be wrong. body={str(body)[:200]}")
        return

    st, _ = http("GET", f"{api}/{'0' * 16}?event={event_id}")
    if st in (403, 404):
        r.ok(f"invalid token rejected ({st})")
    else:
        r.fail("invalid token accepted", f"status={st}")

    # ── 2. Scorecard bootstrap creates leaves only ──────────────────────────
    ex(conn, "UPDATE judging_sessions SET stage = 'IN_PROGRESS' WHERE id IN (%s, %s)",
       (s1["session_id"], s2["session_id"]))

    ex(conn, "DELETE FROM criterion_scores WHERE scorecard_id = %s",
       (judge_a["scorecard_id"],))
    ex(conn, "UPDATE scorecards SET status='NOT_STARTED', total_score=NULL, "
             "submitted_at=NULL WHERE id = %s", (judge_a["scorecard_id"],))

    st, body = http("GET", f"{api}/{tok_a}/scorecards?event={event_id}")
    created = q(conn, "SELECT count(*) AS n FROM criterion_scores WHERE scorecard_id = %s",
                (judge_a["scorecard_id"],))[0]["n"]
    if created == n_leaves:
        r.ok(f"GET /scorecards created exactly {n_leaves} leaf rows")
    else:
        r.bug(f"GET /scorecards created {created} rows, expected {n_leaves}",
              "The portal and the ranking service filter parent criteria "
              "independently. If they disagree, a judge scores rows the ranking "
              "ignores, or the total exceeds the rubric maximum.")

    # ── 3. Draft save, then recovery ────────────────────────────────────────
    partial = leaves[:3]
    payload = {"scorecardId": judge_a["scorecard_id"],
               "scores": [{"criterionId": c["id"], "score": 5,
                           "comment": "partial"} for c in partial]}
    st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}", payload)
    if st in (200, 201):
        r.ok("draft autosave accepted")
    else:
        r.fail("draft autosave rejected", f"status={st} body={str(body)[:200]}")

    row = q(conn, "SELECT status, total_score FROM scorecards WHERE id = %s",
            (judge_a["scorecard_id"],))[0]
    if row["status"] == "DRAFT":
        r.ok("status moved NOT_STARTED to DRAFT")
    else:
        r.fail("status after draft save", f"got {row['status']}")

    st, body = http("GET", f"{api}/{tok_a}/scorecards?event={event_id}")
    got = None
    if isinstance(body, list):
        card = next((c for c in body if c.get("id") == judge_a["scorecard_id"]), None)
        if card:
            got = [s for s in card.get("criterionScores", []) if s.get("score") is not None]
    if got is not None and len(got) == 3:
        r.ok("draft survives a reload (autosave recovery)")
    else:
        r.fail("draft did not survive reload",
               f"expected 3 scored rows, got {len(got) if got is not None else 'unparseable'}")

    # ── 4. totalScore is computed from the payload, not from storage ────────
    stored_sum = q(conn, "SELECT coalesce(sum(score),0) AS s FROM criterion_scores "
                         "WHERE scorecard_id = %s", (judge_a["scorecard_id"],))[0]["s"]
    if row["total_score"] is not None and int(row["total_score"]) != int(stored_sum):
        r.bug(f"total_score {row['total_score']} != sum of stored scores {stored_sum}",
              "saveScore computes totalScore from `incoming` only. A partial "
              "autosave overwrites the total with the sum of just those criteria.")
    else:
        r.ok("total_score matches stored scores after a partial save")

    # Send one criterion on its own and see whether the total collapses.
    one = [{"criterionId": leaves[0]["id"], "score": 4}]
    http("POST", f"{api}/{tok_a}/score?event={event_id}",
         {"scorecardId": judge_a["scorecard_id"], "scores": one})
    after = q(conn, """
        SELECT sc.total_score, coalesce(sum(cs.score),0) AS stored
        FROM scorecards sc LEFT JOIN criterion_scores cs ON cs.scorecard_id = sc.id
        WHERE sc.id = %s GROUP BY sc.total_score
    """, (judge_a["scorecard_id"],))[0]
    if int(after["total_score"] or 0) != int(after["stored"]):
        r.bug(f"single-criterion autosave set total_score to {after['total_score']} "
              f"while stored scores sum to {after['stored']}",
              "Every 20-second autosave rewrites the total from whatever the page "
              "happened to send. The coordinator's completion view and the judge's "
              "own total read this column.")
    else:
        r.ok("total_score consistent after single-criterion autosave")

    # ── 5. Out-of-range scores ──────────────────────────────────────────────
    c0 = leaves[0]
    st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                    {"scorecardId": judge_a["scorecard_id"],
                     "scores": [{"criterionId": c0["id"], "score": c0["max_score"] * 100}]})
    stored = q(conn, "SELECT score FROM criterion_scores WHERE scorecard_id = %s "
                     "AND criterion_id = %s", (judge_a["scorecard_id"], c0["id"]))[0]
    if stored["score"] and stored["score"] > c0["max_score"]:
        r.bug(f"score {stored['score']} stored for a criterion whose max is "
              f"{c0['max_score']}",
              "No range validation server-side. A stale page, a bad client or a "
              "crafted request can put a team's total past the rubric maximum.")
    else:
        r.ok("out-of-range score rejected or clamped")

    st, _ = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                 {"scorecardId": judge_a["scorecard_id"],
                  "scores": [{"criterionId": c0["id"], "score": -5}]})
    neg = q(conn, "SELECT score FROM criterion_scores WHERE scorecard_id = %s "
                  "AND criterion_id = %s", (judge_a["scorecard_id"], c0["id"]))[0]
    if neg["score"] is not None and neg["score"] < 0:
        r.bug("negative score stored", f"score={neg['score']}")
    else:
        r.ok("negative score rejected")

    # ── 5b. Malformed input ─────────────────────────────────────────────────
    # The portal controller takes a plain @Body() with no DTO class, so there is
    # no class-validator pipe: whatever arrives is what the handler sees. These
    # check that the handler itself refuses nonsense with a 400 rather than a
    # 500 — a 500 means an unhandled error, and in this build stack traces are
    # returned to the caller.
    baseline = q(conn, "SELECT score FROM criterion_scores WHERE scorecard_id = %s "
                       "AND criterion_id = %s", (judge_a["scorecard_id"], c0["id"]))
    base_score = baseline[0]["score"] if baseline else None

    def malformed(label: str, scores, extra=None):
        payload = {"scorecardId": judge_a["scorecard_id"], "scores": scores}
        if extra:
            payload.update(extra)
        st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}", payload)
        now = q(conn, "SELECT score FROM criterion_scores WHERE scorecard_id = %s "
                      "AND criterion_id = %s", (judge_a["scorecard_id"], c0["id"]))
        wrote = bool(now) and now[0]["score"] != base_score
        if wrote:
            r.bug(f"{label}: value was stored",
                  f"status={st}, criterion now holds {now[0]['score']}")
        elif st == 400:
            r.ok(f"{label}: rejected (400)")
        elif st in (409, 403, 404):
            r.ok(f"{label}: rejected ({st})")
        elif st >= 500:
            r.bug(f"{label}: server error rather than a validation error",
                  f"status={st}. Unhandled — this build returns stack traces.")
        else:
            r.bug(f"{label}: accepted", f"status={st} body={str(body)[:160]}")

    malformed("text in a score field",
              [{"criterionId": c0["id"], "score": "Alvin"}])
    malformed("numeric string in a score field",
              [{"criterionId": c0["id"], "score": "7"}])
    malformed("fractional score",
              [{"criterionId": c0["id"], "score": 7.5}])
    malformed("boolean score",
              [{"criterionId": c0["id"], "score": True}])
    malformed("criterion id from no template",
              [{"criterionId": "00000000-0000-0000-0000-000000000000", "score": 1}])
    malformed("scores is not an array",
              "not-an-array")
    malformed("comment of 200KB",
              [{"criterionId": c0["id"], "score": 1, "comment": "x" * 200_000}])
    malformed("comment just over the 2000-character limit",
              [{"criterionId": c0["id"], "score": 1, "comment": "x" * 2001}])

    st, _ = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                 {"scorecardId": judge_a["scorecard_id"],
                  "scores": [{"criterionId": c0["id"], "score": 1, "comment": "x" * 2000}]})
    if st in (200, 201):
        r.ok("comment at exactly the 2000-character limit: accepted")
    else:
        r.fail("comment at the limit rejected", f"status={st}")

    st, _ = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                 {"scorecardId": judge_a["scorecard_id"],
                  "scores": [], "overallStrengths": "y" * 5001})
    if st == 400:
        r.ok("over-long free-text summary: rejected (400)")
    elif st >= 500:
        r.bug("over-long free-text summary: server error", f"status={st}")
    else:
        r.bug("over-long free-text summary: accepted", f"status={st}")

    st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                    {"scorecardId": "not-a-uuid",
                     "scores": [{"criterionId": c0["id"], "score": 1}]})
    if st == 400 or st == 404:
        r.ok(f"malformed scorecardId: rejected ({st})")
    elif st >= 500:
        r.bug("malformed scorecardId: server error rather than a validation error",
              f"status={st} — a bad id reaches Prisma unchecked.")
    else:
        r.bug("malformed scorecardId: accepted", f"status={st}")

    # An omitted score is treated as "clear this criterion". Reasonable when a
    # judge deliberately blanks a field; worth knowing it is indistinguishable
    # from a client that forgot to include the value.
    st, _ = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                 {"scorecardId": judge_a["scorecard_id"],
                  "scores": [{"criterionId": c0["id"]}]})
    cleared = q(conn, "SELECT score FROM criterion_scores WHERE scorecard_id = %s "
                      "AND criterion_id = %s", (judge_a["scorecard_id"], c0["id"]))
    if cleared and cleared[0]["score"] is None:
        r.info("a score omitted from the payload clears that criterion "
               "(indistinguishable from a client that forgot it)")
    else:
        r.ok("a score omitted from the payload leaves the stored value alone")

    # ── 5c. A partial save must not erase what it did not mention ───────────
    # A judge scores a team, then comes back later and adds a comment. The
    # comment-only save used to carry `score: null` for that criterion and the
    # server wrote it, so the score vanished — silently, on a routine autosave
    # that is not audited, and only for the field the ranking is built from.
    ex(conn, "DELETE FROM criterion_scores WHERE scorecard_id = %s",
       (judge_a["scorecard_id"],))
    ex(conn, "UPDATE scorecards SET status='NOT_STARTED', total_score=NULL, "
             "submitted_at=NULL WHERE id = %s", (judge_a["scorecard_id"],))

    http("POST", f"{api}/{tok_a}/score?event={event_id}",
         {"scorecardId": judge_a["scorecard_id"],
          "scores": [{"criterionId": c0["id"], "score": 5}]})

    # Now a comment on the same criterion, with no score in the payload.
    http("POST", f"{api}/{tok_a}/score?event={event_id}",
         {"scorecardId": judge_a["scorecard_id"],
          "scores": [{"criterionId": c0["id"], "comment": "added later"}]})

    row = q(conn, "SELECT score, comment FROM criterion_scores "
                  "WHERE scorecard_id = %s AND criterion_id = %s",
            (judge_a["scorecard_id"], c0["id"]))[0]
    if row["score"] == 5 and row["comment"] == "added later":
        r.ok("a comment-only save keeps the score beside it")
    else:
        r.fail("a comment-only save erased the score",
               f"score={row['score']} comment={row['comment']} — expected 5 and "
               f"'added later'")

    # And the reverse: a score-only save must keep the comment.
    http("POST", f"{api}/{tok_a}/score?event={event_id}",
         {"scorecardId": judge_a["scorecard_id"],
          "scores": [{"criterionId": c0["id"], "score": 6}]})
    row = q(conn, "SELECT score, comment FROM criterion_scores "
                  "WHERE scorecard_id = %s AND criterion_id = %s",
            (judge_a["scorecard_id"], c0["id"]))[0]
    if row["score"] == 6 and row["comment"] == "added later":
        r.ok("a score-only save keeps the comment beside it")
    else:
        r.fail("a score-only save erased the comment",
               f"score={row['score']} comment={row['comment']}")

    # An explicit null still clears, because a judge emptying a box means it.
    http("POST", f"{api}/{tok_a}/score?event={event_id}",
         {"scorecardId": judge_a["scorecard_id"],
          "scores": [{"criterionId": c0["id"], "score": None}]})
    row = q(conn, "SELECT score, comment FROM criterion_scores "
                  "WHERE scorecard_id = %s AND criterion_id = %s",
            (judge_a["scorecard_id"], c0["id"]))[0]
    if row["score"] is None and row["comment"] == "added later":
        r.ok("an explicit null clears the score and leaves the comment")
    else:
        r.fail("an explicit null did not clear the score",
               f"score={row['score']} comment={row['comment']}")

    # ── 6. Cross-judge write ────────────────────────────────────────────────
    if judge_b and judge_b["scorecard_id"]:
        before_b = q(conn, "SELECT score FROM criterion_scores WHERE scorecard_id = %s "
                           "AND criterion_id = %s", (judge_b["scorecard_id"], c0["id"]))
        st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                        {"scorecardId": judge_b["scorecard_id"],
                         "scores": [{"criterionId": c0["id"], "score": 1}]})
        after_b = q(conn, "SELECT score FROM criterion_scores WHERE scorecard_id = %s "
                          "AND criterion_id = %s", (judge_b["scorecard_id"], c0["id"]))
        wrote = (before_b and after_b and before_b[0]["score"] != after_b[0]["score"])
        if wrote:
            r.fail("cross-judge write landed in the database",
                   f"status={st} — one judge modified another's scorecard")
        elif st == 403:
            r.ok("one judge cannot write into another's scorecard (403)")
        elif st in (400, 404):
            r.fail("cross-judge write refused, but with the wrong status",
                   f"got {st}, expected 403. The write was blocked, so this is a "
                   f"reporting problem rather than an authorisation hole — but a "
                   f"client cannot distinguish 'not yours' from 'bad payload'.")
        else:
            r.fail("cross-judge write not blocked", f"status={st}")

    # ── 7. Full submit ──────────────────────────────────────────────────────
    full = [{"criterionId": c["id"], "score": max(1, c["max_score"] // 2),
             "comment": "ok"} for c in leaves]
    expected_total = sum(s["score"] for s in full)
    st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                    {"scorecardId": judge_a["scorecard_id"], "scores": full,
                     "overallStrengths": "s", "areasForImprovement": "a",
                     "recommendation": "r", "submit": True})
    if st in (200, 201):
        r.ok("full submit accepted")
    else:
        r.fail("full submit rejected", f"status={st} body={str(body)[:300]}")

    sub = q(conn, """
        SELECT sc.status, sc.total_score, sc.submitted_at, sc.conflict_confirmed,
               coalesce(sum(cs.score),0) AS stored
        FROM scorecards sc LEFT JOIN criterion_scores cs ON cs.scorecard_id = sc.id
        WHERE sc.id = %s
        GROUP BY sc.status, sc.total_score, sc.submitted_at, sc.conflict_confirmed
    """, (judge_a["scorecard_id"],))[0]

    if sub["status"] == "SUBMITTED":
        r.ok("status is SUBMITTED")
    else:
        r.fail("status after submit", f"got {sub['status']}")
    if sub["submitted_at"]:
        r.ok("submitted_at set")
    else:
        r.fail("submitted_at not set")
    if int(sub["total_score"] or 0) == expected_total == int(sub["stored"]):
        r.ok(f"total_score, payload and stored scores all agree ({expected_total})")
    else:
        r.fail("submit totals disagree",
               f"total_score={sub['total_score']} payload={expected_total} "
               f"stored={sub['stored']}")

    # ── 7b. Submit with no prior draft ──────────────────────────────────────
    # The sequence a judge who works quickly actually uses: open the scorecard,
    # fill it in one sitting, press Submit. No draft was ever saved and the
    # twenty-second autosave has not fired, so the scorecard is still
    # NOT_STARTED.
    #
    # This shipped broken. Every existing check saved a draft first, so 33
    # passing tests said nothing about it.
    ex(conn, "DELETE FROM criterion_scores WHERE scorecard_id = %s",
       (judge_a["scorecard_id"],))
    ex(conn, "UPDATE scorecards SET status='NOT_STARTED', total_score=NULL, "
             "submitted_at=NULL WHERE id = %s", (judge_a["scorecard_id"],))

    fresh = q(conn, "SELECT status FROM scorecards WHERE id = %s",
              (judge_a["scorecard_id"],))[0]
    st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                    {"scorecardId": judge_a["scorecard_id"], "scores": full,
                     "overallStrengths": "s", "areasForImprovement": "a",
                     "recommendation": "r", "submit": True})
    after = q(conn, "SELECT status, total_score FROM scorecards WHERE id = %s",
              (judge_a["scorecard_id"],))[0]

    if after["status"] == "SUBMITTED":
        r.ok(f"submit straight from {fresh['status']} accepted "
             f"(no draft saved first)")
    else:
        r.fail("submit from NOT_STARTED refused",
               f"status={st} scorecard={after['status']} — a judge who scores a "
               f"team in one sitting has not saved a draft, and the autosave "
               f"has not fired. body={str(body)[:200]}")

    # ── 8. Double submit ────────────────────────────────────────────────────
    st, body = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                    {"scorecardId": judge_a["scorecard_id"], "scores": full,
                     "submit": True})
    if st == 400:
        r.ok("second submit refused (400)")
    else:
        r.fail("double submit not refused", f"status={st}")

    n_cards = q(conn, "SELECT count(*) AS n FROM scorecards WHERE session_id = %s "
                      "AND judge_id = %s", (s1["session_id"], judge_a["id"]))[0]["n"]
    if n_cards == 1:
        r.ok("still exactly one scorecard for this judge and session")
    else:
        r.fail("duplicate scorecards created", f"count={n_cards}")

    # ── 9. Reopen, then resubmit ────────────────────────────────────────────
    ex(conn, "UPDATE scorecards SET status='REOPENED' WHERE id = %s",
       (judge_a["scorecard_id"],))
    st, _ = http("POST", f"{api}/{tok_a}/score?event={event_id}",
                 {"scorecardId": judge_a["scorecard_id"], "scores": full, "submit": True})
    reop = q(conn, "SELECT status FROM scorecards WHERE id = %s",
             (judge_a["scorecard_id"],))[0]
    if reop["status"] == "RESUBMITTED":
        r.ok("reopened scorecard resubmits as RESUBMITTED")
    else:
        r.fail("resubmit status", f"got {reop['status']}")

    # ── 10. Break rules ─────────────────────────────────────────────────────
    if judge_ps:
        st, body = http("POST", f"{api}/{tok_ps}/break?event={event_id}",
                        {"sessionId": s1["session_id"], "onBreak": True})
        if st == 403:
            r.ok("PS judge cannot declare a break (403)")
        else:
            r.fail("PS break not refused", f"status={st}")

    if judge_b:
        tok_b = token_for(judge_b["id"], salt)
        ex(conn, "UPDATE scorecards SET status='NOT_STARTED', total_score=NULL, "
                 "submitted_at=NULL WHERE id = %s", (judge_b["scorecard_id"],))
        ex(conn, "DELETE FROM criterion_scores WHERE scorecard_id = %s",
           (judge_b["scorecard_id"],))

        # Draft, then break: the draft must be discarded.
        http("POST", f"{api}/{tok_b}/score?event={event_id}",
             {"scorecardId": judge_b["scorecard_id"],
              "scores": [{"criterionId": leaves[0]["id"], "score": 7}]})
        st, _ = http("POST", f"{api}/{tok_b}/break?event={event_id}",
                     {"sessionId": s1["session_id"], "onBreak": True})
        after_break = q(conn, """
            SELECT sc.status, count(cs.score) AS scored
            FROM scorecards sc LEFT JOIN criterion_scores cs
              ON cs.scorecard_id = sc.id AND cs.score IS NOT NULL
            WHERE sc.id = %s GROUP BY sc.status
        """, (judge_b["scorecard_id"],))[0]
        if after_break["status"] == "NOT_STARTED" and after_break["scored"] == 0:
            r.ok("break discards a draft and resets the scorecard")
            r.info("note: the draft is discarded with no confirmation and no undo; "
                   "the endpoint returns success either way")
        else:
            r.fail("break did not discard the draft",
                   f"status={after_break['status']} scored={after_break['scored']}")

        # A second IG judge breaking on the same session must be refused.
        other_ig = next((j for j in js1 if j["id"] not in (judge_b["id"],)
                         and j["judge_tier"] in ("L2", "L3", "L4")), None)
        if other_ig:
            tok_o = token_for(other_ig["id"], salt)
            st, body = http("POST", f"{api}/{tok_o}/break?event={event_id}",
                            {"sessionId": s1["session_id"], "onBreak": True})
            if st == 400:
                r.ok("second IG judge cannot also break (400)")
            else:
                r.fail("two IG judges allowed to break the same session",
                       f"status={st} — the team would be scored by one judge")

        http("POST", f"{api}/{tok_b}/break?event={event_id}",
             {"sessionId": s1["session_id"], "onBreak": False})

    # ── 11. Stage gate ──────────────────────────────────────────────────────
    ex(conn, "UPDATE judging_sessions SET stage='SCHEDULED' WHERE id = %s",
       (s2["session_id"],))
    j2 = js2[0]
    tok2 = token_for(j2["id"], salt)
    st, body = http("POST", f"{api}/{tok2}/score?event={event_id}",
                    {"scorecardId": j2["scorecard_id"],
                     "scores": [{"criterionId": leaves[0]["id"], "score": 3}]})
    if st == 400:
        r.ok("scoring refused while the session is SCHEDULED (400)")
    else:
        r.fail("scoring allowed before the session started", f"status={st}")

    # ── restore ─────────────────────────────────────────────────────────────
    for sid, stage in original_stages.items():
        ex(conn, "UPDATE judging_sessions SET stage=%s WHERE id=%s", (stage, sid))
    for j in js1 + js2:
        if j["scorecard_id"]:
            ex(conn, "DELETE FROM criterion_scores WHERE scorecard_id=%s",
               (j["scorecard_id"],))
            ex(conn, "UPDATE scorecards SET status='NOT_STARTED', total_score=NULL, "
                     "submitted_at=NULL, overall_strengths=NULL, "
                     "areas_for_improvement=NULL, recommendation=NULL, "
                     "conflict_confirmed=false WHERE id=%s", (j["scorecard_id"],))
    ex(conn, "UPDATE session_judges SET on_break=false, break_at=NULL "
             "WHERE session_id IN (%s, %s)", (s1["session_id"], s2["session_id"]))
    r.info("database restored")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--event", required=True)
    p.add_argument("--base", default="http://localhost:4000")
    p.add_argument("--salt", default=None,
                   help="overrides JUDGE_TOKEN_SALT; defaults to the API's default")
    args = p.parse_args()

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("set DATABASE_URL", file=sys.stderr)
        return 2

    salt = args.salt or os.environ.get("JUDGE_TOKEN_SALT") or "hackjudge-salt-2026"

    r = Results()
    print(f"\njudge portal: {args.base}/api/judge-portal")
    print(f"script version: {VERSION}")
    print(f"event {args.event}\n")

    with psycopg.connect(url, row_factory=dict_row) as conn:
        try:
            run(conn, args.base.rstrip("/"), args.event, salt, r)
        except SystemExit:
            raise
        except Exception as e:
            r.fail("test aborted", f"{type(e).__name__}: {e}")

    fails = [x for x in r.rows if x[0] == FAIL]
    bugs = [x for x in r.rows if x[0] == BUG]
    passes = [x for x in r.rows if x[0] == PASS]

    print(f"\n  {len(passes)} passed, {len(fails)} failed, {len(bugs)} defects\n")
    for level, name, _ in fails + bugs:
        print(f"    {level}  {name}")
    print()
    return 1 if (fails or bugs) else 0


if __name__ == "__main__":
    sys.exit(main())
