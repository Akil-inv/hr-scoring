# HackJudge — Session 5 Handover

**Date:** 29–30 July 2026
**Repo:** https://github.com/Akil-inv/hackathon-platform
**Live:** https://judge.igworkflowstudio.com (also judge.uobigedm.com)
**EC2:** i-0047ffa1dc45b46c4 — `/opt/hackjudge/hackathon-platform`
**Local:** `./dev.sh start | stop | restart | build | logs`
**Deploy:** `./deploy.sh` on EC2 (backs up, pulls, builds, restarts, health-checks)
**Login:** admin@hackathon.local / admin123 — must be promoted to SUPER_ADMIN after every `migrate reset`

---

## The event this is for

Confirmed against the real participation deck, not assumed:

- **79 teams**, judged across **three days**: 28 August, 31 August, 1 September.
  Not contiguous — a weekend sits in the middle.
- **Two tracks.** Track 1 is ten curated enterprise problems taken up by 24
  teams, so several teams solve the *same* use case. Track 2 is 55 teams with
  self-identified problems, roughly one use case each.
- **Countries:** SG 50, TH 13, VN 7, MY 5, ID 3, CN 1. Twenty-nine remote.
- **Two rooms**, ~16 judging slots a day, so 96 room-slots for 79 teams. Tight.
- **Two MDs** available as room anchors. This is the binding constraint on
  anchoring, and their `max_sessions` must be ≥ the total judging slots — 40,
  not the default 10.

Track 1's shared use cases were settled as a fairness question: four teams
solving AI-Enabled KYC judged by different panels produce scores that are not
comparable. **Use case grouping wins over country grouping** where they
conflict. *This is decided but not built* — see Outstanding.

---

## What was built this session

### Guided scheduling — sequential passes

Guided mode no longer hands all 79 teams to the solver at once. It runs a
sequence of smaller solves, each locking the previous, so rules are honoured in
priority order and a failure names the rule rather than reporting "infeasible".

Order: remote teams by country (same-timezone countries first, then those an
hour behind), then platform clusters largest-first, then everything else.

- `apps/api/src/scheduling/passes.ts` — the planner
- `apps/scheduler/src/solver.py` — room restriction, clustering, day-awareness

**Country ordering solves the timezone problem implicitly.** Running MY, HK and
CN through the morning puts TH, ID and VN comfortably past 09:00 local by the
time they start, with no separate rule.

**Verified result:** every country lands in a single day in a tight window —
13 Thai teams inside two and a half hours. Platform clusters likewise.

### Three fixes that mattered

**Solver budget scales with problem size.** CP-SAT spends whatever it is given,
so twelve passes at a flat 120s came to 24 minutes against a 150s API ceiling.
Now two seconds per team, floored at 10 and capped at 120 — twelve passes total
around 100 seconds. API ceiling raised to 300s.

**Workload balance was measuring something it could not change.** `load_diff`
spanned every judge including anchors, who sit at 39–40 by design — so max was
pinned at 40, min at 0, and the term was a constant. A constant gives the
solver no gradient, so it ignored balance entirely: six judges got zero
sessions while others carried twelve. Now measured across only the judges the
solver can assign. Result: everyone between 2 and 5.

**Clustering measured slot indices, not calendar time.** Slots run date-then-
time, so index 0 and index 18 could both be 09:00 on different days. Split into
spread-within-day plus a penalty for days touched.

### Judge availability — now required

A separate CSV upload (`email, date, session`) with one row per judge per day.
**A judge with no availability recorded is excluded from scheduling entirely** —
absent means absent, not "assume free".

- `apps/api/src/judges/availability-import.controller.ts`
- Upload step in Event Setup with per-day coverage counts

### Judge portal — rebuilt

Light theme throughout, type up roughly 25%, nothing below 14px. The judges are
MDs and EDs reading between presentations, often on a phone.

**Four quadrants instead of a list.** A judge with forty sessions will not
scroll to find the one thing that needs them — and a chronological list is
exactly where the urgent thing hides. Tapping a quadrant expands it into the
same space, so the page height never changes and nothing scrolls.

- `apps/web/src/components/quadrant-view.tsx`
- Awaiting you (amber) · Up next (steel) · Done (lilac) · Revisit (sea green)
- Anodised metal finish: 315° gradient, bevelled rim from layered shadows
- Phone: 2×2 compact squares fitting one screen
- **Scoring is sticky** — submitting an outstanding scorecard opens the next
  until the queue empties. Everything else returns to the quadrants.

**Use case panel** (`use-case-panel.tsx`) — full-screen, opened from the live
ribbon, the next three sessions, or an open scorecard. Closing returns exactly
where it opened from, so a judge mid-scorecard keeps their entries.

**Revisit flag** — `flaggedForReview` on Scorecard, set from a button beside
the scorecard's close control. Independent of submission.

### Messaging

Coordinator to judge, shown in the portal's lower ribbon with a "Got it" that
dismisses it.

- One active message per judge — a new one supersedes the old
- Dismissal is the only expiry; an undismissed message is itself information
- No replies
- **Session-level:** a "note" control on each Command Centre card opens compose
  with that session's panel pre-selected
- 30-second poll, so delivery takes up to half a minute

### Smaller things

- Schedule builder: filter bar (platform, country, track, use case) between the
  judge pool and planner, filtering both the remaining pile and the planner
- Print and Export CSV on the schedule builder — full universe, status column
- Country flags and platform chips on Command Centre and planner cards
- Judge Links shows session counts, busiest first, zeros flagged amber
- Command Centre legibility: nothing below 12px, muted greys lifted to clear
  4.5:1 contrast

---

## Data files

In `/mnt/user-data/outputs/real-data/` from this session, built to match the
real event:

- `teams.csv` — 79 teams, Track 1 with the ten real use cases and their real
  team assignments, Track 2 filling the remaining country counts
- `judges.csv` — 33 judges, 2 MDs with `max_sessions` 60
- `judge-availability.csv` — 93 rows across the three days

---

## Outstanding

### Next up

**Event-scoped RBAC.** Specified but not built: admins fenced to their own
event, super admin owning all user management. The guard still checks global
roles only, so today any admin can act on any event.

### Bugs worth fixing

**Criteria are not locked once scoring starts.** Editing a criterion mid-event
silently invalidates every submitted scorecard, with no warning. This is the
only remaining item that can corrupt real data during the event.

**Delete-with-children fails opaquely** in three places: `removeCriterion`,
`swapTeams`, and clearing teams that have sessions. The operation fails and the
user sees nothing useful.

**Judge tier chips** in Event Setup show only L1–L4, not PS or V — a
coordinator would think those judges had not imported.

**`reset.sh` references `judge_availabilities`**, which is not the table name.
It would fail if anyone ran it.

**Drift metronome** is still drawn for a dark background and looks wrong in the
light Done tile.

### Designed, agreed, not built

**Track 1 use case clustering.** Teams sharing a use case should be judged
consecutively by the same panel. Currently the four Market Sentiment Insights
teams are spread across three days and two panels, so their scores are not
comparable. Decided in this session; not implemented.

**The Break button.** Cover L3s are scheduled on every fifth session and
returned as `coverSlotIds`, but an L2 has no way to take the break. The whole
mechanism is inert.

**Vendor blocks.** Declaring a block, rendering cluster boundaries on the
Command Centre, swap-within-cluster enforcement. Agreed as Command Centre only —
no judge-facing part.

### Explicitly not doing

Per decisions this session: no further scheduler tuning, no judging-day picker
(manual slot clearing is an acceptable workaround), no vendor blocks for judges.

---

## Things that will bite

**Judge portal has its own data path.** `judge-portal.controller.ts` holds REST
queries separate from the GraphQL service. Any change to what a scorecard
returns must be applied in both, or it is silently ignored. This cost an hour
this session when `flaggedForReview` reached the flag route but not the
scorecards response.

**Verify a symbol reached `dist`, not just the source.** Twice this session an
hour went to measuring behaviour from code that was never compiled — once
because a duplicate identifier broke the build silently, once because a patch
was presented but never applied. `grep -c "symbol" apps/api/dist/...` before
testing anything.

**Changing event dates orphans time slots** outside the new range. They keep
existing, remain schedulable, and are invisible in the UI. Delete them directly
in SQL.

**Downloads collision.** Patch files repeatedly saved as `name-2.py` because an
older version was already there, and the old one got applied. Clear Downloads
between sessions.

**`prisma migrate dev` resets the database** when it detects drift, which
happened three times. Everything must be re-imported afterwards, in order:
tracks, teams, judges, availability, rooms, slots.

**Timestamps in psql are UTC.** Singapore is +8, so raw query output looks eight
hours early. Use `at time zone 'Asia/Singapore'`.

---

## Reference documents

- `/mnt/user-data/outputs/PRODUCTISING-NOTES.md` — where the platform assumes
  this event, and what would need to change for another. Six seams identified
  with file locations.
- `/mnt/user-data/outputs/SCHEDULER-RULES.md` — v2, tiers and anchoring
- `/mnt/user-data/outputs/ROLES-AND-ACCESS.md` — the RBAC model as specified
- `/mnt/user-data/outputs/technical-delivery-assistant-jd.md` — JD drafted
  against the shape of this work

---

## Where to start tomorrow

RBAC is the largest remaining piece and the one you said you would take on.
Criteria locking is the one with real consequences during the event and is
comparatively small — worth doing first if the event is close.

Everything is deployed to EC2 as of the end of this session.
