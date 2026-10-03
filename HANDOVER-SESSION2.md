# HANDOVER — Session 2 Complete

## Date: 25-26 July 2026
## Repo: https://github.com/Akil-inv/hackathon-platform
## Live: https://judge.uobigedm.com
## Login: admin@hackathon.local / admin123

---

## 1. Platform & Infrastructure

### Cloud Architecture
- **EC2**: `i-0047ffa1dc45b46c4`, t3.medium, Amazon Linux 2023
- **Subnet**: `webserver-private-app-1` (private, 10.0.128.0/20)
- **VPC**: `webserver-vpc` (vpc-0ee848babbe930d47)
- **ALB**: `appsflyer` (existing, shared) — HTTPS:443 listener
- **ALB Rule**: Priority 10, host header `judge.uobigedm.com` → target group `hackjudge-tg`
- **ACM Cert**: `9ee268f5-d491-4e26-a865-561ba85bdc13` (judge.uobigedm.com, Issued)
- **Route53**: A record `judge.uobigedm.com` → ALB alias
- **IAM Role**: `SSMroleforEC2` (with SES + SNS permissions, hop limit = 2)
- **Security Group**: `Hackathon-judge` (sg-028b0467fdc48ead3) — SSH 22 from 0.0.0.0/0, HTTP 80 from ALB SG

### Docker Services (on EC2)
```
/opt/hackjudge/hackathon-platform/
├── docker-compose.yml
├── .env (DB_PASSWORD, JWT_SECRET)
├── nginx/default.conf
├── apps/api/Dockerfile (node:20-bookworm-slim, openssl, USER node)
├── apps/web/Dockerfile (node:20-alpine, USER node)
├── apps/scheduler/Dockerfile (python:3.11-slim, USER appuser)
└── reset.sh
```

| Container | Image | Port | Status |
|---|---|---|---|
| postgres | postgres:16-alpine | 5432 | Healthy |
| api | hackathon-platform-api | 4000 | Running |
| web | hackathon-platform-web | 3000 | Running |
| scheduler | hackathon-platform-scheduler | 8001 | Running |
| nginx | nginx:alpine | 80 | Running |

### Key Configuration
- ALB handles SSL termination — nginx serves HTTP only on port 80
- `NEXT_PUBLIC_API_URL=""` (empty string = relative URLs through nginx)
- nginx routes: `/api/` and `/graphql` → api:4000, `/` → web:3000, `/api/events/` → SSE config
- nginx timeouts: 180s for API/GraphQL, 86400s for SSE
- API Dockerfile: `RUN chown -R node:node /app` before `USER node` (fixes schema.gql write permission)
- API CMD: `npx prisma migrate deploy && node dist/main.js` (no seed — runs once only)
- `tsconfig.build.json` required for `nest build` (excludes prisma/seed.ts and test files)
- `next.config.js` has `ignoreBuildErrors: true` for production builds

### Deployment Workflow
```bash
# Always: Mac → Git → EC2 (never edit directly on EC2)

# Mac (build + test + push):
cd ~/hackathon-platform
# make changes
cd apps/api && rm -rf dist && npx nest build  # verify build
cd ~/hackathon-platform
git add -A && git commit -m "message" && git push

# EC2 (pull + deploy only):
cd /opt/hackjudge/hackathon-platform
git fetch origin && git reset --hard origin/main
docker-compose build --no-cache api && docker-compose up -d api

# If git conflicts:
git push --force  # from Mac
git fetch origin && git reset --hard origin/main  # on EC2
```

### Backup
```bash
# Manual backup
docker-compose exec -T postgres pg_dump -U hackathon hackathon > /opt/hackjudge/backups/backup_$(date +%Y%m%d_%H%M%S).sql

# Restore
docker-compose exec -T postgres psql -U hackathon hackathon < /opt/hackjudge/backups/backup_XXXXXXXX.sql

# Cron: every 6 hours, auto-delete after 7 days
```

### Reset Script
```bash
cd /opt/hackjudge/hackathon-platform
./reset.sh
# Type RESET to confirm — clears all event data, preserves users
```

---

## 2. What Was Built — Session 2

### Phase 5 — Rankings
- **Backend**: `calculateRankings`, `approveRankings`, `publishRankings` mutations + `rankings` query
- **Service**: Criterion-level averaging across judges, tie-break rules (highest criterion avg → judge count)
- **Frontend**: Full rankings page with track tabs, medal badges, expandable criterion breakdown
- **Workflow**: PROVISIONAL → APPROVED → PUBLISHED
- **Exports**: Export Rankings CSV + Export All Data (5 CSVs)
- **Methodology modal**: ? icon shows full calculation with worked examples (3 judges vs 5 judges scenario)
- **Judge names**: Displayed in table and included in CSV exports
- **Files**: `apps/api/src/rankings/` (module, types, service, resolver), `apps/web/src/app/dashboard/rankings/page.tsx`

### Phase 6 — Exports
- 6 CSV export endpoints at `apps/api/src/export/export.controller.ts`:
  - `/api/export/schedule` — full schedule with judge assignments
  - `/api/export/scores-raw` — one row per judge × team × criterion
  - `/api/export/scores` — one row per scorecard with all criteria + comments
  - `/api/export/team-aggregates` — per-team avg/min/max/stddev
  - `/api/export/judge-analytics` — per-judge harshness index
  - `/api/export/rankings` — indicative leaderboard with judge names
- All exports filter on `SUBMITTED/RESUBMITTED/LOCKED` only (no drafts)
- UTF-8 BOM for Excel compatibility
- Uses `ScorecardStatus` enum (not string literals) for Prisma typing

### Notifications
- **SES email**: Working ✅ — branded HTML template with portal link button
- **SNS SMS**: AWS accepts messages but Singapore carriers silently drop alphanumeric sender IDs
  - Direct CLI test delivers (without sender ID)
  - Platform-triggered SMS with sender ID gets dropped by carriers
  - Removed `IGC2026` sender ID — SMS may work without it but delivery is unreliable
  - SMS is unreliable in Singapore via AWS SNS — use email as primary
- **WhatsApp**: Not implemented — requires Meta Business API approval (24-48h)
- **Backend**: `apps/api/src/notification/notification.controller.ts` — `/api/notify/send` and `/api/notify/send-batch`
- **Frontend**: `apps/web/src/app/dashboard/judge-links/page.tsx` — config panel (SES/SNS/Both toggle), send per judge, delivery status
- **SES verified domain**: `uobdmoedm.com` (sender: `support@uobdmoedm.com`)

### Phone Number Support
- `phone` column added to `judges` table (via direct SQL on EC2)
- Import service accepts `phone` from CSV
- JudgeLink GraphQL type includes `phone`
- Judge portal service returns `phone`
- **CSV warning**: Excel converts phone numbers to scientific notation (e.g. `9.18051E+11`). Format phone column as Text before saving.
- Phone numbers must be E.164 format: `+6591234567` (with `+` prefix)

### RBAC (Backend Done, Frontend Pending)
- **Schema**: `EventRole` enum (ADMIN, COORDINATOR, PANEL_CHAIR, AUDITOR), `EventUser` join table (userId + eventId + role)
- **`SUPER_ADMIN`** added to `Role` enum — global access, bypasses all role checks
- **DB applied**: Direct SQL on EC2 (migration file exists but applied manually)
- **Admin user**: Updated to `SUPER_ADMIN` role, name = "Admin"
- **Coordinator user**: name = "Coordinator"
- **Backend mutations**: `createUser`, `deleteUser`, `resetUserPassword`, `assignEventRole`, `removeEventRole`
- **Backend queries**: `users`, `myEvents`
- **Files**: `apps/api/src/users/` (service, resolver, module)
- **Auth guard**: SUPER_ADMIN bypass added to roles guard
- **Frontend store**: `apps/web/src/lib/event-store.ts` — Zustand store for event context (created, not wired)
- **Frontend pages**: ❌ NOT BUILT — no user management page, no event selector in sidebar

### Reliability Layer
- **Health controller**: `apps/api/src/health.controller.ts` — DB ping, scheduler check, memory stats, liveness/readiness endpoints
- **Global exception filter**: `apps/api/src/global-exception.filter.ts` — structured HTTP + GraphQL error responses, stack trace logging for 500s
- **Logging interceptor**: `apps/api/src/logging.interceptor.ts` — slow request logging (>1s) for HTTP + GraphQL
- **Timeout interceptor**: `apps/api/src/timeout.interceptor.ts` — 30s default timeout
- **Validation pipe**: `apps/api/src/validation.pipe.ts` — created but DISABLED in main.ts (breaks login without class-validator decorators on DTOs)
- **Prisma service**: `apps/api/src/prisma/prisma.service.ts` — 5-retry with exponential backoff, error/warn logging, graceful disconnect
- **main.ts**: All wired except validation pipe — CORS, exception filter, logging interceptor, timeout interceptor, shutdown hooks, uncaught exception handlers

### Test Suite
- 7 spec files, 48 tests, all passing
- Files: `health.controller.spec.ts`, `global-exception.filter.spec.ts`, `rankings.service.spec.ts`, `validation.pipe.spec.ts`, `timeout.interceptor.spec.ts`, `prisma.service.spec.ts`, `logging.interceptor.spec.ts`
- Coverage report generated at `apps/api/coverage/`

### Scheduler Improvements
- Solver timeout: 120s (up from 60s) for 60-70 team events
- Room stickiness, max sessions constraint, AM/PM grouping (from Session 1)

### Quality Report Progress
| Scan | Score | Findings | Security | Notes |
|------|-------|----------|----------|-------|
| 1 | 55 | 48 | 10/15 | 34 high (npm deps) |
| 2 | 62 | 6 | 13/15 | npm audit fixed most |
| 3 | 66 | 1 | 15/15 | Only bcrypt Dockerfile |
| 4 | 58 | 43 | 10/15 | npm audit ran again |

- Current best: **66/100, CONDITIONAL PASS, Security 15/15, Architecture 10/10**
- Remaining: 2 high (Next.js + PostCSS — upstream, can't fix without major upgrade), 1 medium (bcrypt Dockerfile in node_modules)
- Score gap: Test strength (3/15) and Reliability (3/10) need more test coverage to improve

---

## 3. Event Scale Planning

**Target**: 60-70 teams, 20-25 judges, 5-8 coordinators, 2 days

### Capacity Requirements
| Resource | Minimum | Recommended |
|---|---|---|
| Rooms | 3 | 4 |
| Judges (at 3/team) | 30-35 | 35 |
| Judges (at 4/team) | 40+ | 45 |
| Max sessions/judge | 8-10/day | 8 (sustainable quality) |
| Time slots/room/day | ~16 (25min intervals, 7h judging) | 16 |

### Server Sizing
- t3.medium handles 70 teams with 10x headroom
- Peak concurrent: ~33 users (25 judges + 8 coordinators)
- CPU: ~15% avg, 40% peak during schedule generation
- Memory: ~1.8GB of 4GB

---

## 4. Scoring Methodology

### How Rankings Are Calculated
1. Collect all SUBMITTED/LOCKED scorecards per team
2. For each criterion, compute arithmetic mean across all judges
3. Sum criterion averages = team aggregated score
4. Rank by score descending
5. Tie-break: highest single criterion average, then judge count
6. Rankings start as PROVISIONAL → Admin approves → publishes

### What the System Does NOT Do (by design)
- Weight by judge tier (L1/L2/L3 treated equally)
- Normalize for judge count (3-judge avg = 5-judge avg)
- Adjust for harsh/lenient judges
- Drop outlier scores

These are handled offline by the calibration panel using exported data.

### Criteria (default)
- Innovation: /20 (20%)
- Business Impact: /40 (40%)
- Feasibility: /10 (10%)
- Collaboration: /20 (20%)
- Judge Bonus: /10 (10%)

---

## 5. SSE Real-Time Layer (Built, Not Wired)

### Files Created
- `apps/api/src/events/events.service.ts` — PG LISTEN/NOTIFY bridge with in-process fallback
- `apps/api/src/events/events.controller.ts` — SSE endpoints for dashboard + judge portal
- `apps/api/src/events/events.module.ts` — Global module, injectable anywhere
- `apps/web/src/lib/use-event-stream.ts` — React hook with auto-reconnect + exponential backoff

### Not Yet Done
- EventsModule not registered in app.module.ts
- No event emissions from operations service, judge portal, or rankings
- Frontend pages don't use the hook yet

---

## 6. Database State

### Users
| Email | Role | Name |
|---|---|---|
| admin@hackathon.local | SUPER_ADMIN | Admin |
| coordinator@hackathon.local | COORDINATOR | Coordinator |

### Schema
- `event_users` table: created via direct SQL (userId + eventId + role)
- `EventRole` enum: ADMIN, COORDINATOR, PANEL_CHAIR, AUDITOR
- `Role` enum: includes SUPER_ADMIN
- `judges.phone` column: added via direct SQL
- Event data: cleared by reset script — needs re-creation via Event Setup

---

## 7. Known Issues & Gotchas

### Deployment
- Always build on Mac, push, pull on EC2. Never edit directly on EC2.
- `git push --force` from Mac, `git fetch && git reset --hard origin/main` on EC2 when diverged
- Docker `USER node` requires `RUN chown -R node:node /app` before it (schema.gql write permission)
- `tsconfig.build.json` must exist (excludes seed.ts and test files)
- `next.config.js` needs `ignoreBuildErrors: true`
- Alpine Docker images miss OpenSSL for Prisma — use `bookworm-slim`

### Validation Pipe
- Created but DISABLED — `forbidNonWhitelisted: true` rejects login because `LoginInput` DTO has no class-validator decorators
- Re-enable after adding `@IsEmail()`, `@IsString()` decorators to all DTOs
- File exists at `apps/api/src/validation.pipe.ts` but not imported in `main.ts`

### SMS
- Singapore carriers silently drop alphanumeric sender IDs (e.g. "IGC2026")
- AWS SNS returns success even when carrier drops the message
- Removed sender ID from notification controller
- SMS delivery is 1-2 minutes delayed even when it works
- Email is the reliable channel — use SMS as secondary only

### Phone Numbers
- Excel converts long numbers to scientific notation — format as Text before CSV save
- Must be E.164 format with `+` prefix: `+6591234567`

### Prisma Migrations
- `migrate dev` needs local DB — use `migrate deploy` on EC2 or direct SQL
- Some schema changes applied via direct SQL on EC2 (phone, event_users, SUPER_ADMIN)
- Migration files may not match actual DB state

---

## 8. Session 3 — Build List

### P0 — Must Have
- [ ] **User management frontend page** — create users, assign roles per event (backend done, no UI)
- [ ] **Event selector in sidebar** — pick which event to manage (Zustand store created, UI not built)
- [ ] **Batch notification UI** — send 15 at a time with channel toggle, delivery status per judge
- [ ] **Dashboard KPIs** — wire live data to existing dashboard page
- [ ] **65-team dry run** — full simulation with multiple judges scoring simultaneously

### P1 — Should Have
- [ ] Phone number visible + editable on Judge Links page
- [ ] Wire SSE events (register EventsModule, emit from operations/judge-portal/rankings)
- [ ] Re-enable validation pipe with class-validator decorators on all DTOs
- [ ] WhatsApp wa.me deep links as manual fallback on Judge Links page

### P2 — Nice to Have
- [ ] Multi-round advancement (Round 1 → top N → Round 2)
- [ ] Focus loss fix on room/track name inputs
- [ ] Judge availability setting from UI
- [ ] Score anomaly detection
- [ ] Public results portal

---

## 9. File Inventory — All Session 2 Changes

### Backend (apps/api)
| File | Status |
|---|---|
| src/main.ts | Rewritten — reliability wiring (no validation pipe) |
| src/health.controller.ts | NEW — DB/scheduler/memory health checks |
| src/global-exception.filter.ts | NEW — structured error handling |
| src/logging.interceptor.ts | NEW — slow request logging |
| src/timeout.interceptor.ts | NEW — 30s timeout |
| src/validation.pipe.ts | NEW — created but disabled |
| src/prisma/prisma.service.ts | Rewritten — 5-retry, error logging |
| src/rankings/ (module, types, service, resolver) | NEW |
| src/export/export.controller.ts | NEW — 6 CSV endpoints |
| src/export/export.module.ts | NEW |
| src/notification/notification.controller.ts | NEW — SES + SNS |
| src/notification/notification.module.ts | NEW |
| src/users/users.service.ts | NEW — RBAC user management |
| src/users/users.resolver.ts | NEW — GraphQL mutations |
| src/users/users.module.ts | NEW |
| src/judge-portal/judge-portal.resolver.ts | Updated — phone field in JudgeLink |
| src/judge-portal/judge-portal.service.ts | Updated — returns phone |
| src/judges/judges.service.ts | Updated — imports phone from CSV |
| src/judges/judges.types.ts | Updated — phone field on JudgeEntity |
| prisma/schema.prisma | Updated — EventRole, EventUser, SUPER_ADMIN, phone |
| Dockerfile | Rewritten — bookworm-slim, openssl, chown, USER node |
| tsconfig.build.json | NEW — excludes seed and tests |
| 7 spec files | NEW — 48 tests |

### Frontend (apps/web)
| File | Status |
|---|---|
| src/app/dashboard/rankings/page.tsx | Complete rewrite — methodology modal, exports, judge names |
| src/app/dashboard/judge-links/page.tsx | Updated — notification config, send buttons |
| src/app/dashboard/event/page.tsx | Fixed — refetch, sessionDuration |
| src/lib/event-store.ts | NEW — Zustand store for event context |
| src/lib/use-event-stream.ts | NEW — SSE React hook |
| next.config.js | NEW — ignoreBuildErrors |
| Dockerfile | NEW — USER node |

### Scheduler (apps/scheduler)
| File | Status |
|---|---|
| src/solver.py | Updated — 120s timeout, unused vars removed |
| Dockerfile | NEW — USER appuser |

### Infrastructure
| File | Status |
|---|---|
| docker-compose.yml | Updated — ALB config, no certbot |
| nginx/default.conf | Updated — HTTP only, SSE support, 180s timeouts |
| reset.sh | NEW — data reset script |
