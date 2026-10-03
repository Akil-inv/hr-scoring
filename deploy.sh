#!/usr/bin/env bash
#
# Deploy the HR Scoring stack. Run this ON the server, from the repo root
# (for example inside an SSM session).
#
#   ./deploy.sh                 pull the current branch, build, migrate, restart
#   ./deploy.sh --no-pull       rebuild what is already checked out
#   ./deploy.sh --force         go ahead even if free memory is low
#
#   DEPLOY_BRANCH=main ./deploy.sh   deploy a different branch
#
# This server also runs the live hackathon platform. Everything here touches
# only the hr-scoring Compose project; the live containers are never named,
# rebuilt or restarted.
#
# Order:
#   1. disk and memory check
#   2. database backup (skipped on the very first deploy)
#   3. pull
#   4. build, one service at a time
#   5. migrate
#   6. start
#   7. verify, and print the Tailscale address

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUPS="${BACKUPS:-$ROOT/../backups}"
MIN_FREE_GB=5
MIN_MEM_MB=800
WARN_MEM_MB=1500

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "${GRN}✓${OFF} $*"; }
warn() { echo "${YEL}!${OFF} $*"; }
err()  { echo "${RED}✗${OFF} $*"; }
step() { echo; echo "${DIM}── $* ──${OFF}"; }

cd "$ROOT" || exit 1

# The server has the standalone docker-compose binary; newer machines have the
# plugin. Use whichever exists.
if command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else DC="docker compose"; fi
dc() { $DC "$@"; }

PULL=1
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --force) FORCE=1 ;;
    *) err "unknown option: $arg"; exit 1 ;;
  esac
done

BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

if [ ! -f .env ]; then
  err ".env not found. Copy .env.example to .env and fill it in first."
  exit 1
fi

# ── 1. disk and memory ─────────────────────────────────────────────────────

step "disk and memory"
FREE_GB=$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')
echo "  disk: ${FREE_GB}G free"
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  warn "under ${MIN_FREE_GB}G free — clearing build cache"
  docker builder prune -f >/dev/null 2>&1
  FREE_GB=$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')
  if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
    err "still under ${MIN_FREE_GB}G free. Not building."
    exit 1
  fi
fi

MEM_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapFree/ {print int($2/1024)}' /proc/meminfo)
echo "  memory: ${MEM_MB}MB available, ${SWAP_MB}MB swap free"
if [ "$MEM_MB" -lt "$MIN_MEM_MB" ] && [ "$FORCE" = 0 ]; then
  err "under ${MIN_MEM_MB}MB available. Building now could starve the live platform."
  echo "    add swap (see docs/DEPLOY-HR-SCORING.md) or run with --force"
  exit 1
elif [ "$MEM_MB" -lt "$WARN_MEM_MB" ]; then
  warn "memory is tight; builds will run one at a time"
fi
ok "checks passed"

# ── 2. backup ──────────────────────────────────────────────────────────────

step "backup"
BACKUP=""
if dc ps --status running postgres 2>/dev/null | grep -q postgres; then
  mkdir -p "$BACKUPS"
  BACKUP="$BACKUPS/hr-scoring_$(date +%Y%m%d_%H%M%S).sql"
  if dc exec -T postgres pg_dump -U hackathon hackathon > "$BACKUP" 2>/dev/null && [ -s "$BACKUP" ]; then
    ok "backed up ($(du -h "$BACKUP" | cut -f1)) → $BACKUP"
    ls -1t "$BACKUPS"/hr-scoring_*.sql 2>/dev/null | tail -n +11 | xargs -r rm -f
  else
    err "backup failed — stopping"
    exit 1
  fi
else
  warn "database not running yet — first deploy, nothing to back up"
fi

# ── 3. pull ────────────────────────────────────────────────────────────────

BEFORE=$(git rev-parse --short HEAD)
if [ "$PULL" = 1 ]; then
  step "pull $BRANCH"
  git fetch origin "$BRANCH" --quiet || { err "git fetch failed"; exit 1; }
  git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
  git reset --hard "origin/$BRANCH" --quiet || { err "git reset failed"; exit 1; }
  AFTER=$(git rev-parse --short HEAD)
  if [ "$BEFORE" = "$AFTER" ]; then warn "already at $AFTER"; else ok "$BEFORE → $AFTER"; fi
else
  step "pull skipped"
fi
git log --oneline -1 | sed 's/^/  /'

# ── 4. build ───────────────────────────────────────────────────────────────

# One at a time. Compose builds in parallel by default, and three builds at
# once next to a live platform is the memory spike this avoids.
for svc in api scheduler web; do
  step "build $svc"
  if ! dc build "$svc"; then
    err "build of $svc failed — nothing has been restarted"
    exit 1
  fi
  ok "$svc built"
done

# ── 5. migrate ─────────────────────────────────────────────────────────────

step "migrate"
if ! dc run --rm api npx prisma migrate deploy; then
  err "migration failed — nothing has been restarted"
  exit 1
fi
ok "migrations applied"

# ── 6. start ───────────────────────────────────────────────────────────────

step "start"
dc up -d || { err "start failed"; exit 1; }
ok "containers up"

# ── 7. verify ──────────────────────────────────────────────────────────────

step "verify"
HEALTHY=0
for _ in $(seq 1 30); do
  if dc exec -T nginx wget -qO- http://127.0.0.1/api/health 2>/dev/null | grep -q '"status"'; then
    HEALTHY=1; break
  fi
  sleep 3
done

dc ps

if [ "$HEALTHY" = 0 ]; then
  err "API not answering through nginx after 90s"
  echo; echo "last 30 lines of api log:"
  dc logs --tail=30 api | sed 's/^/    /'
  echo
  warn "to roll back:"
  echo "    git reset --hard $BEFORE && ./deploy.sh --no-pull"
  [ -n "$BACKUP" ] && echo "    $DC exec -T postgres psql -U hackathon hackathon < $BACKUP"
  exit 1
fi
ok "API healthy"

# Tailscale signs in a few seconds after its container starts, and until then
# its DNS name is empty. Wait for it, and read the name from the Self block
# rather than whichever DNSName appears first.
ADDR=""
for _ in $(seq 1 20); do
  ADDR=$(dc exec -T tailscale tailscale status --json 2>/dev/null \
    | awk '/"Self"/ {self=1} self && /"DNSName"/ {print; exit}' \
    | sed -E 's/.*"DNSName": *"([^"]*)".*/\1/; s/\.$//')
  [ -n "$ADDR" ] && break
  sleep 3
done
echo
if [ -n "$ADDR" ]; then
  ok "deployed — open https://$ADDR from a device on your tailnet"
else
  warn "deployed, but Tailscale has not reported an address yet:"
  echo "    $DC logs --tail=30 tailscale"
fi
