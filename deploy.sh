#!/usr/bin/env bash
#
# Deploy to EC2. Run this ON the EC2 box, from the repo root.
#
#   ./deploy.sh              build and restart api, web, scheduler
#   ./deploy.sh api          just one service
#   ./deploy.sh --no-pull    skip git, rebuild what is already checked out
#
# What it does, in order:
#   1. checks disk space and refuses to build if tight
#   2. backs up the database
#   3. pulls main
#   4. builds
#   5. restarts
#   6. verifies containers are up and health responds
#
# Disk is checked first because a --no-cache build filled the volume once and
# nearly took the platform down. Postgres failing writes mid-event would lose
# judging data.

set -uo pipefail

ROOT="/opt/hackjudge/hackathon-platform"
BACKUPS="/opt/hackjudge/backups"
MIN_FREE_GB=5

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "${GRN}✓${OFF} $*"; }
warn() { echo "${YEL}!${OFF} $*"; }
err()  { echo "${RED}✗${OFF} $*"; }
step() { echo; echo "${DIM}── $* ──${OFF}"; }

cd "$ROOT" 2>/dev/null || { err "not found: $ROOT — are you on EC2?"; exit 1; }

PULL=1
SERVICES="api web scheduler"
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    api|web|scheduler|nginx|postgres) SERVICES="$arg" ;;
  esac
done

# ── 1. disk ─────────────────────────────────────────────────────────────────

step "disk"
FREE_GB=$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')
USED_PCT=$(df / | awk 'NR==2 {gsub("%","",$5); print $5}')
echo "  ${FREE_GB}G free, ${USED_PCT}% used"

if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  warn "under ${MIN_FREE_GB}G free — reclaiming"
  docker image prune -f >/dev/null 2>&1
  docker builder prune -f >/dev/null 2>&1
  FREE_GB=$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')
  echo "  now ${FREE_GB}G free"
  if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
    err "still under ${MIN_FREE_GB}G. Run: docker image prune -a -f"
    exit 1
  fi
fi
ok "enough space"

# ── 2. backup ───────────────────────────────────────────────────────────────

step "backup"
mkdir -p "$BACKUPS"
STAMP=$(date +%Y%m%d_%H%M%S)
BACKUP="$BACKUPS/deploy_$STAMP.sql"

if docker-compose exec -T postgres pg_dump -U hackathon hackathon > "$BACKUP" 2>/dev/null; then
  SIZE=$(du -h "$BACKUP" | cut -f1)
  if [ ! -s "$BACKUP" ]; then
    err "backup is empty — stopping"
    exit 1
  fi
  ok "backed up ($SIZE) → $BACKUP"
else
  err "backup failed — stopping. Is postgres running?"
  exit 1
fi

# keep the last 10
ls -1t "$BACKUPS"/deploy_*.sql 2>/dev/null | tail -n +11 | xargs -r rm -f

# ── 3. pull ─────────────────────────────────────────────────────────────────

if [ "$PULL" = 1 ]; then
  step "pull"
  BEFORE=$(git rev-parse --short HEAD)
  git fetch origin --quiet || { err "git fetch failed"; exit 1; }
  git reset --hard origin/main --quiet || { err "git reset failed"; exit 1; }
  AFTER=$(git rev-parse --short HEAD)

  if [ "$BEFORE" = "$AFTER" ]; then
    warn "already at $AFTER — nothing new"
  else
    ok "$BEFORE → $AFTER"
  fi
  git log --oneline -1 | sed 's/^/  /'
else
  step "pull skipped"
  git log --oneline -1 | sed 's/^/  /'
fi

# ── 4. build ────────────────────────────────────────────────────────────────

step "build: $SERVICES"
# No --no-cache. Layer reuse is safe here and --no-cache is what filled the
# disk. If you genuinely need a clean build, pass it by hand once.
if ! docker-compose build $SERVICES; then
  err "build failed — nothing has been restarted, the old containers are still serving"
  exit 1
fi
ok "built"

# ── 4b. migrate ─────────────────────────────────────────────────────────────

# After the build so the image contains the migration files, and before the
# restart so the new code never starts against an old schema.
step "migrate"
if ! docker-compose run --rm api npx prisma migrate deploy; then
  err "migration failed — nothing has been restarted, the old containers are still serving"
  exit 1
fi
ok "migrations applied"

# ── 5. restart ──────────────────────────────────────────────────────────────

step "restart"
docker-compose up -d --force-recreate $SERVICES || { err "restart failed"; exit 1; }
ok "containers recreated"

# ── 6. verify ───────────────────────────────────────────────────────────────

step "verify"
sleep 8

docker-compose ps

echo
for _ in $(seq 1 20); do
  if curl -s --max-time 3 http://localhost/health | grep -qE 'ok|"status"'; then
    ok "health responding"
    curl -s http://localhost/health | head -c 200; echo
    break
  fi
  sleep 2
done

if ! curl -s --max-time 3 http://localhost/health | grep -qE 'ok|"status"'; then
  err "health not responding after 40s"
  echo
  echo "last 30 lines of api log:"
  docker-compose logs --tail=30 api | sed 's/^/    /'
  echo
  warn "to roll back:"
  echo "    git reset --hard $BEFORE && ./deploy.sh --no-pull"
  echo "    docker-compose exec -T postgres psql -U hackathon hackathon < $BACKUP"
  exit 1
fi

echo
ok "deployed"
echo "${DIM}  backup:  $BACKUP${OFF}"
echo "${DIM}  logs:    docker-compose logs -f api${OFF}"
