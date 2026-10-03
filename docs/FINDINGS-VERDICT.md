# Every finding — does it exist, and do we fix it

Checked against the code. No framing, just the verdict.

---

## Fix — 4 findings

| Finding | Exists | Why fix |
|---|---|---|
| **L10-N1-007** `create-scorecards.js` | Yes | Referenced by nothing. A leftover script, not application code. **Delete the file** — the finding goes with it |
| **L10-N1-001** `operations.service.ts:193` | Yes | Check-then-create over 3 judges. The query count is irrelevant, but the pattern is a **race condition** — two concurrent calls both find nothing and both create. `createMany({ skipDuplicates: true })` is one query and the database enforces uniqueness |
| **L10-N1-004/005** `operations.service.ts:634, 649` | Yes | Checks each judge for a clash before a swap. One query with `judgeId: { in: [...] }` gives the same answer and **names every busy judge** instead of only the first — a better message for a coordinator mid-swap |
| **L9-DOCK-015** bcrypt Dockerfile | **No** | Scans `apps/api/node_modules/bcrypt/Dockerfile`. Not our file, not in our build. All three of our Dockerfiles set `USER`. **Suppress in the engine's config** |

---

## Real, don't fix — 2 findings

| Finding | Exists | Why not |
|---|---|---|
| **L10-N1-002/003** `operations.service.ts:576, 587` | Yes | Loops over `a.judges` and `b.judges` — 3 each. Six queries during a manual swap. Rewriting them as batched lookups makes the code harder to read and saves nothing measurable. **Accept** |

---

## Real, can't fix before the event — 15 findings

**`xlsx` (HIGH).** No patched version exists at any version; SheetJS withdrew
from npm. The CVEs are prototype pollution and ReDoS from crafted files, and the
upload endpoint is behind `JwtAuthGuard` — reachable only by an authenticated
coordinator, not the public. **Replace with `exceljs` after the event.** It is
contained to `spreadsheet.ts`, about an hour, but it is the file-import path for
teams, judges and availability, and that is not a path to change three weeks out
with no test coverage on it.

**`next` (HIGH).** Fix requires `next@16`, a major upgrade. All 21 advisories
concern the Image Optimizer, Server Actions, middleware, rewrites or i18n. This
application uses none of them — checked, not assumed. **Defer.**

**`postcss` (HIGH).** A `devDependency`, transitive through Next's build. It
does not ship to production and does not run at request time. **Defer**, and it
should arguably not be flagged at this severity at all.

**Twelve `@nestjs/*` and `@apollo/*` medium findings.** All resolve only by
upgrading NestJS 10 → 11 and Apollo Server 4 → 5. Both are major upgrades across
a running application. **Defer to after 1 September.**

---

## What to do now

1. `git rm apps/api/create-scorecards.js` — one finding, zero risk
2. Fix line 193 — real race condition
3. Fix 634 and 649 — better error, one query
4. Suppress the bcrypt Dockerfile finding in the engine's exclusions
5. Record 576, 587 as accepted with the loop size as the reason
6. Record the 15 dependency findings as deferred, with the specific blocker
   against each

That takes High from 9 to 3, and the 3 remaining are the three that genuinely
require a major upgrade or a library replacement.
