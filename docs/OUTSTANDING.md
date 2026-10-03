# Outstanding — HackJudge

**As of 10 August 2026, after deploy `35dcea6`.**

Things that are wrong and should be fixed. Decisions, preferences and
observations are not on this list; if it is here, the system is doing something
it should not.

---

## 1. A stale device is not told its save was refused

**Where:** judge portal, multi-device save path
**Found by:** Playwright, `judge-multidevice.spec.ts`

A judge with the same scorecard open on two devices saves from the older one.
The write is correctly refused — the newer scores survive, which is the part
that matters — but nothing appears on the stale screen. The judge believes
their scores were saved.

The 409 is returned. The message does not reach the judge. Telling them was the
entire point of the rule; refusing the write silently is only half of it.

**Why it matters:** a judge who thinks they have scored a team and has not is
exactly the failure the concurrency work was built to prevent. They walk away.

**Shape of the fix:** find where the 409 branch's `setMessage` output renders
relative to the scorecard panel. The panel may be closing before the message
appears — the same behaviour that broke the Playwright submit tests.

---

## 2. There is no way to activate a scoring template

**Where:** `scoring-templates.service.ts`, and the coordinator UI
**Found by:** deploying to EC2

Templates are created `DRAFT` and nothing in the codebase ever sets `ACTIVE` —
no mutation, no button. Scoring and ranking both now refuse a draft template,
correctly, which means a coordinator setting up a fresh event reaches a state
they cannot leave: judges are told the rubric is not ready and there is no
control that makes it ready.

Worked around on both environments with SQL. That is not a procedure anyone
should have to follow at eight in the morning.

**Why it matters:** every ranking calculated before 10 August was computed
against a draft rubric, and nothing said so. The guard is right; the missing
control is not.

**Shape of the fix:** an `activateTemplate` mutation with the usual role guard,
and a control in the scoring template page. `DRAFT` → `ACTIVE` only, audited.

---

## 3. A corrupted criterion name

**Where:** production scoring template `78775ad6`, the 15-point Business Impact row

> Quantitative impact Is the potential value from the POC more than SGD 500k
> per annum? OR above 50% efficiency gain (from time savings / **productiv,
> duplift**)

Two faults from one bad paste: a missing separator after "Quantitative impact",
and `productiv, duplift` where "productivity uplift" belongs. The sibling row
reads "Qualitative impact - Does the solution…", so the intended form is clear.

**Why it matters:** eleven judges read this string once per team. Seventy-nine
teams.

**Shape of the fix:** through the coordinator UI, not SQL — `updateCriterion`
with only a name is permitted by the structural lock, and it writes an audit
entry. That record is worth having for a rubric change this close to the event.

---

## 4. `resetSchedule` deletes the audit trail

**Where:** `scheduling.resolver.ts`, and `reset.sh`

Both delete `audit_logs` along with the event data. The specification says
audit entries are append-only and survive a reset, because the trail exists to
answer questions about what happened — including questions about the reset.

**Why it matters:** small, but it is the one record that should outlive
everything else, and it currently outlives nothing.

**Shape of the fix:** remove `audit_logs` from both delete lists. If the table
needs clearing between events, that should be a separate, deliberate action.

---

## Deliberately not on this list

- **Two L2 judges for two rooms.** Real and important, and not a defect. It is
  a question for whoever owns the judge roster: is there a third MD, or is one
  of the nine L3s misfiled? No code changes this.
- **An omitted score clears that criterion.** `undefined` and `null` are treated
  alike. With sparse saves the client always sends a value, so this is
  theoretical. It needs a decision recorded, not a change made.
- **The Playwright submit tests.** Six failures, all test mechanics — a click
  landing after the scorecard panel closes. The platform correctly refuses an
  incomplete scorecard; the test was feeding it one.
- **Dependency findings.** `xlsx`, `next`, `postcss` and the NestJS moderates,
  already adjudicated. The bcrypt Dockerfile finding is a false positive
  against a file inside `node_modules`.

---

## Not defects, but nothing has exercised them

Stated so they are known gaps rather than assumed coverage.

- **No human has scored through the browser on EC2.** Every check has been HTTP
  or SQL.
- **No load and no failure injection.** Twelve judges polling for three days, a
  Postgres stall mid-session — untested.
- **The two-device flow has never been done by a person**, only by a test that
  covers three of its four rules.

One rehearsal on EC2 — real people, real browsers, generate, score, rank,
hand-check one team on paper — would close all three and would very likely
surface item 1 on its own.
