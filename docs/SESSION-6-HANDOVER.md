# HackJudge — Session 6 handover

**8–9 August 2026**

**Repo** https://github.com/Akil-inv/hackathon-platform
**Live** https://judge.igworkflowstudio.com · https://judge.uobigedm.com
**EC2** i-0047ffa1dc45b46c4 — `/opt/hackjudge/hackathon-platform` — SSM access only
**Local** `./dev.sh start | stop | restart | build | logs`
**Deploy** `./deploy.sh` on EC2. **Pushing to GitHub does not touch EC2** — the
instance only changes when deploy runs there.
**Login** admin@hackathon.local / admin123 — must be SUPER_ADMIN after any
`migrate reset`

---

## The event

79 teams · 3 judging days: 28 Aug, 31 Aug, 1 Sept (weekend in the middle) ·
2 rooms · Track 1 has 10 curated use cases across 24 teams, Track 2 is 55 teams
with their own · SG 50, TH 13, VN 7, MY 5, ID 3, CN 1, of which 29 remote.

**Judges: 3 MDs (L2), 3 EDs (L3), 4 SVPs (L4), 2 PS, plus L1 leadership and
vendors.**

---

## The big change this session: panel composition replaced anchoring

Rather than pinning one MD to a room for a whole day, every panel is now drawn
per session:

    1 × MD (L2)  +  1 × ED or SVP (L3/L4)  +  1 × PS

Ten in the IG pool, two drawn per session, plus the mandatory PS.

Three MDs sharing 79 sessions is 26 each rather than 40, and `max_sessions` no
longer needs to be set to 40 or the solve fails in a way that looks like a
capacity problem. `anchors.ts` is no longer called.

The rule travels as data — `judge_composition` on the solver request — so a
different panel shape is a payload change, not a solver change.

**PS is now the tightest constraint**: 2 judges for 2 rooms means both are in a
session every slot with no spare. One unavailable half-day and the schedule will
not fill. The capacity check says so.

---

## Judge-declared breaks

Either IG judge may step out of a single session. Never both — one of them plus
the PS is two scorers, which is the floor. Both out would leave the PS scoring
alone.

**The PS never breaks.** One per session, no cover.

- Judge declares it from the live session ribbon; a coordinator can mark it from
  the session card on their behalf. Both write the same field.
- Refused once that judge has submitted — the score is evidence.
- A draft is discarded on stepping out; a half-formed judgement of a session
  they did not see is worse than none.

**Rankings needed no change.** Averages are taken across submitted scorecards,
so a judge who does not submit is already excluded. A session with one break
averages two scores.

**The completion counting did need changing**, and this was the point: without
it a session with a break reads 2/3 forever, which is indistinguishable from a
judge who is simply late. `scorecardsTotal` now excludes judges on break, the
outstanding panel skips them, and `judgesOnBreak` is shown so a shorter panel has
a visible reason.

---

## Timezone — the bug that kept recurring

`Event.timezone` existed since the first migration and **nothing read it**. So
four places each invented their own answer.

The real bug: availability windows were stored as AM `00:00–12:00` and PM
`13:00–23:59` in **UTC**. For Singapore that makes PM 21:00 to 07:59 local,
matching no judging slot at all. **Every PM-only judge was silently
unschedulable.** Masked only because the sample data was mostly BOTH.

Fixed with one helper, `apps/api/src/common/event-time.ts`, read by the
availability import, the scheduler, the capacity check and the judge portal. Plus
a timezone picker in Event Setup — the field was never editable.

**Verified:** schedulable judges went 29 → 33 after re-importing availability.

**If availability is ever re-imported, set the timezone first** — the import
reads it to build the windows.

---

## Other functional work

**Remove a judge from a session** — an × on the expanded Command Centre card.
Only above the event minimum, only while SCHEDULED, refused if that judge has
submitted.

**Room availability** — `room_unavailability`, stored sparsely: no rows means
every room is available. Deliberately the opposite default to judge availability,
where silence must mean unavailable. Captured as a table in slot creation, saved
on click, independent of generation. The solver folds exclusions into
`occupied_room_slots` — an unavailable room is, to the solver, an occupied one.

**Skip weekends** toggle beside the date range, on by default. Filters the day
list at source so the availability table, the Generate buttons and the capacity
check all agree.

**Collapsible setup steps** — finished steps collapse, the first unfinished one
stays open.

**Excel import** for teams, judges and availability. CSV loses data on the round
trip: a solution summary reading "faster onboarding, fewer errors, lower cost"
splits into three columns once the quoting is lost, and nothing downstream can
tell. Verified with a real file.

**Criteria locked once scoring starts** — triggered by the first submission, not
by the schedule existing. A rubric and a schedule are independent; a coordinator
fixing a typo the day after generating is doing nothing wrong. Names and
descriptions stay editable; anything changing the arithmetic does not.

**Scorecard autosave** — 20 seconds after the last change, immediately on
`visibilitychange`, mirrored to sessionStorage, with a `beforeunload` warning.
There was none at all: twelve criteria of scoring lived in React state until the
judge pressed Save.

**The message ribbon floats** at `z-[70]`, above the scorecard and use case
panel, and wraps rather than truncating.

**Updated rubric** from the 31 July criteria sheet — 9 rows, not 12. Business
Impact is four rows with quantitative impact at 15, and Feasibility and Team
Collaboration are each one row because the sheet scores their two questions
together.

---

## Event scoping (partial RBAC)

`EventUser` recorded assignments and **no resolver read it**.

Now: the event list is filtered by assignment, and a guard checks the `eventId`
argument on the 15 operations that name one. The other 54 identify their target
by session or scorecard id, which needs a per-entity lookup — those remain
unguarded.

**In practice the filtered list does most of the work**: an event you cannot see
is one you cannot navigate to. Reaching an unguarded operation needs a UUID from
an event you cannot see.

**Assignment is opt-in.** A user with no rows sees everything — denying by
default would have locked out every account on deploy. So *assigning* someone is
what restricts them.

---

## Hardening

**Security** — CORS was `origin: true` with `credentials: true`, which lets any
site a logged-in coordinator visits call the API as them. Now an allow-list from
`CORS_ORIGINS`. Plus helmet, rate limiting (generous — judges poll every 30s),
introspection off in production, and the judge token salt moved to
`JUDGE_TOKEN_SALT`.

**Operational** — `docker-compose.yml` had no log rotation, so 95,000 portal
requests a day accumulated unbounded until the disk filled and Postgres stopped
accepting writes. Now capped at 20m × 3 per service, plus memory limits (so the
solver dies before the OOM killer picks Postgres), a CPU cap on the scheduler,
healthchecks on api and scheduler, and a raised Prisma connection pool.

**`event-guard.sh`** — install on EC2 before the event:
`sudo bash event-guard.sh install`. A watchdog restarting the API after two
consecutive health failures (Compose healthchecks report and do nothing), and a
backup every 15 minutes. Set `S3_BUCKET` or backups stay on the same disk as the
database.

---

## Testing

**48 Jest** unit tests · **10 pytest** solver tests · **7.28% line coverage**.

The pytest suite is new and covers the solver's constraints rather than its
optimiser — whether a schedule is *legal*, not whether it is *good*. Two of the
ten cover regressions that actually happened.

`conftest.py` skips rather than aborts when ortools cannot load — it is a native
extension that kills the process rather than raising, which is what happens
outside the venv.

Both e2e specs skip with an explanation when there is no database. A suite that
fails because infrastructure is absent teaches everyone to ignore its failures.

**A contract test asserts the two scorecard paths agree.** The judge portal has
its own REST queries separate from the GraphQL service, and they have drifted
twice.

---

## External quality engine (CodeForge)

Five runs. Score 55–58/100, gate FAIL.

**What responded correctly**: static analysis 461 findings → 0. Performance
2/5 → 3/5 as N+1s were fixed. Build 7 → 8. Maintainability 6 → 7.

**What has never moved across five runs**: Test strength 3/15, coverage 0%,
Reliability 3/10, and "7 passed, 12 failed" — despite skip guards, lcov and
cobertura reporters, a root `npm test`, and full container hardening. Locally the
same code gives 58 tests passing and 7.28% coverage.

**Worth asking whoever built the engine what commands layers 1, 3 and 4 run and
from which directory.** The static layers clearly work.

### Findings closed

- All N+1 patterns — verified zero direct `prisma`/`tx` calls inside loops
- Dependency findings 20 → 15, high severity 7 → 3, via `overrides` pinning
  patched versions within the same major
- `create-scorecards.js` deleted — referenced by nothing

### Findings remaining, and why

**`xlsx` (HIGH)** — no patched version exists at any version; SheetJS withdrew
from npm. Upload is behind `JwtAuthGuard`, so reachable only by an authenticated
coordinator. Replace with `exceljs` — contained to `spreadsheet.ts`, about an
hour.

**`next` (HIGH)** — needs `next@16`. All 21 advisories concern the Image
Optimizer, Server Actions, middleware, rewrites or i18n. **None are used** —
verified by grep, not assumed.

**`postcss` (HIGH)** — a devDependency, build-time only, never ships.

**12 `@nestjs/*` and `@apollo/*` mediums** — resolve only by upgrading NestJS
10 → 11 and Apollo 4 → 5.

**The bcrypt Dockerfile finding is a false positive** — it scans
`node_modules/bcrypt/Dockerfile`. All three of our Dockerfiles set `USER`.
Suppress it.

---

## Two bugs worth understanding, because both were silent

**The scorecard creation race.** Starting a session read for an existing
scorecard then created one — but read on `{ eventId, judgeId, teamId }` while the
unique constraint is `{ sessionId, judgeId }`. A judge who had scored that team
in a rescheduled session read as "exists" and got **no scorecard for the session
actually starting**. They would open their portal mid-session and find nothing to
score. Fixed with `createMany({ skipDuplicates: true })`.

**The PM availability window.** Described above. Four PM-only judges were
unschedulable and the solver simply worked around them.

Neither produced an error. Both produced quietly wrong behaviour.

---

## Outstanding

### Before the event

1. **Install `event-guard.sh` on EC2** — watchdog and 15-minute backups
2. **Prove a backup restores** — untested backups are not backups
3. **Set `CORS_ORIGINS` and `JUDGE_TOKEN_SALT` on EC2**, and never change the
   salt once judge links have been sent — every existing link would break
4. **Set `min_judges_per_team` to 3 on EC2** — it was 2, which is why a schedule
   produced 79 sessions with two judges each
5. **Re-import judge availability on EC2** — its windows were written under the
   old UTC scheme, so its PM-only judges are still unschedulable
6. **Load the standard rubric on EC2** — the file changing does not alter the
   database
7. **Verify the batched slot lookup** — generate a schedule and confirm
   `count(*)` and `count(scheduled_start)` both read 79. This is the one change
   that could produce silently wrong data rather than an error

### Decisions open

**NestJS 10 → 11 and Apollo 4 → 5.** Clears 12 mediums. One to two days
including a full regression pass — schedule generation, judge portal, scoring,
exports, all three imports. Three weeks is enough time if it starts now. Worth
weighing honestly: a framework upgrade touches every request path, which makes it
a larger mid-event risk than the DoS advisories it resolves.

**`xlsx` → `exceljs`.** One file, about an hour, clears the last fixable HIGH.

**Synchronous scheduling with no resume.** A crash at pass ten discards ten
solves and ~100 seconds. The schedule is built before the event, so a failure
costs a retry rather than an incident.

**Track 1 use case clustering.** Teams sharing a use case should be judged
consecutively by the same panel. Currently the four Market Sentiment Insights
teams spread across three days and two panels, so their scores are not
comparable. **The one unbuilt item with a fairness consequence for teams.**

### Smaller

- `lastSaved` is set on every autosave and rendered nowhere — a judge cannot see
  their work is safe
- `dayUsable` is computed in slot generation and never displayed
- Four `role="button"` spans have no keyboard handler
- The × still renders on a running session; the rule is enforced server-side, so
  it refuses rather than removes
- `scoringLockState` exists as a query with no UI
- The drift metronome is drawn for a dark background, in a light tile

---

## Things that will bite

**`prisma migrate dev` resets the database** when it detects drift. It happened
repeatedly. **Generate migrations locally, apply on the host with
`migrate deploy`.** Never edit a migration after it has been applied — that
causes a checksum mismatch, and the offered fix is a reset.

**Configuration differs between environments.** `min_judges_per_team` was 2 on
EC2 and 3 locally, producing a schedule that looked plausible and was wrong.
Check before concluding anything about judge assignment.

**Verify a symbol reached `dist`, not just the source.** `grep -c "symbol"
apps/api/dist/...` before testing anything.

**Reused guards need reading.** `assertEditable` blocks only COMPLETED and
CANCELLED; reusing it for judge removal let a judge be taken off a running
session.

**The judge portal has its own data path.** `judge-portal.controller.ts` holds
REST queries separate from the GraphQL services. A change to scorecard shape must
be applied in both. The contract test catches it now.

**npm `overrides` must stay within the same major.** Forcing
`path-to-regexp@8` on Express 4 replaced a function export and the API would not
boot. All 48 tests still passed, because none of them boots Express.

**Files repeatedly did not reach the repo from Downloads.** Five times.
`grep -c` after every copy.

**Timestamps in psql are UTC.** Singapore is +8.

---

## Reference documents

In `/mnt/user-data/outputs/`:

- `FINDINGS-VERDICT.md` — every engine finding: exists, fix or not, why
- `CODEFORGE-RUN4-ANALYSIS.md` — what the score movements mean
- `ACCESS-MATRIX.md` — every feature against every role
- `EVENT-RISK-RUNBOOK.md` — what to do when something breaks on the day
- `TECHNICAL-HARDENING.md` — the container-level reasoning
- `JUDGE-RISKS.md` — what can go wrong for a judge specifically
- `PRODUCTISING-NOTES.md` — the six seams for a second event
- `SESSION-5.md` — the previous session

---

## Where to start

Confirm the batched slot lookup with a real schedule. Then decide on the
framework upgrade — that is the one open question with a deadline attached, and
three weeks is enough time only if it starts now.
