#!/usr/bin/env bash
#
# Deploy the HR Scoring stack. Run this ON the server, from the repo root
# (for example inside an SSM session).
#
#   ./deploy.sh                 pull the current branch, build, migrate, restart, check
#   ./deploy.sh --no-pull       rebuild what is already checked out
#   ./deploy.sh --force         go ahead even if free memory is low
#   ./deploy.sh --status        what is running, and what a rollback would put back
#   ./deploy.sh --rollback      put back the previous release (asks first)
#        --with-database        also restore the database from before that release
#                               (only needed when the release changed the database)
#        --yes                  don't ask (for scripts)
#   ./deploy.sh --allow-blocked deploy even though the last release was rolled back
#                               and nothing since reverts it
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
#   3. pull (refused if it would bring back a release that was rolled back)
#   4. keep the running images as the rollback point, then build
#   5. migrate
#   6. start
#   7. check: API, database, scheduler, sign-in page, GraphQL.
#      If the check fails, the previous release is put back automatically
#      (and the database, if this release changed it), and an alert is sent.
#
# Rolling back never installs anything new: it only restores the images,
# code and data that were running before.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUPS="${BACKUPS:-$ROOT/../backups}"
RELEASES="${RELEASES:-$ROOT/../releases}"
STATE="$RELEASES/current.env"
BLOCKED="$RELEASES/blocked"
SERVICES="api scheduler web"
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
MODE=deploy
WITH_DB=0
YES=0
ALLOW_BLOCKED=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --force) FORCE=1 ;;
    --rollback) MODE=rollback ;;
    --status) MODE=status ;;
    --with-database) WITH_DB=1 ;;
    --yes) YES=1 ;;
    --allow-blocked) ALLOW_BLOCKED=1 ;;
    *) err "unknown option: $arg"; exit 1 ;;
  esac
done

BRANCH="${DEPLOY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

if [ ! -f .env ]; then
  err ".env not found. Copy .env.example to .env and fill it in first."
  exit 1
fi

mkdir -p "$RELEASES" && chmod 700 "$RELEASES"

# ── helpers ────────────────────────────────────────────────────────────────

# Tell a person. Always written to releases/alerts.log; also sent to the SNS
# topic in ALERT_TOPIC_ARN (in .env) when that is set and the AWS CLI is here.
alert() {
  local subject="$1" body="$2"
  printf '%s  %s\n%s\n\n' "$(date -u +%FT%TZ)" "$subject" "$body" >> "$RELEASES/alerts.log"
  local topic
  topic=$(grep -E '^ALERT_TOPIC_ARN=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')
  if [ -n "$topic" ] && command -v aws >/dev/null 2>&1; then
    local region; region=$(echo "$topic" | cut -d: -f4)
    if aws sns publish --region "$region" --topic-arn "$topic" --subject "$subject" --message "$body" >/dev/null 2>&1; then
      ok "alert sent"
    else
      warn "alert could not be sent to $topic (is sns:Publish allowed for this server's role?) — it is in $RELEASES/alerts.log"
    fi
  else
    warn "alert written to $RELEASES/alerts.log (set ALERT_TOPIC_ARN in .env to have it emailed)"
  fi
}

# "name id" of the image a running service uses, e.g. "hr-scoring-api sha256:…"
image_of() {
  local cid
  cid=$(dc ps -q "$1" 2>/dev/null | head -1)
  [ -n "$cid" ] || return 1
  docker inspect -f '{{.Config.Image}} {{.Image}}' "$cid" 2>/dev/null
}

save_state() {
  {
    printf 'RELEASE_AT=%q\n' "$(date -u +%FT%TZ)"
    printf 'RELEASE_COMMIT=%q\n' "$1"
    printf 'PREVIOUS_COMMIT=%q\n' "$2"
    printf 'BACKUP=%q\n' "$3"
    printf 'DB_CHANGED=%q\n' "$4"
    printf 'IMAGES=%q\n' "$5"
    printf 'ROLLED_BACK=%q\n' "$6"
  } > "$STATE"
}

# Does anything in apps/api/prisma (schema or migrations) differ between two commits?
db_changed() {
  git diff --quiet "$1" "$2" -- apps/api/prisma 2>/dev/null && echo 0 || echo 1
}

# What a person would notice first: is the API up, does it reach the database
# and the scheduler, does the sign-in page load, does GraphQL answer?
SMOKE_FAIL=""
smoke_once() {
  SMOKE_FAIL=""
  local h
  h=$(dc exec -T nginx wget -qO- http://127.0.0.1/api/health 2>/dev/null)
  echo "$h" | grep -q '"database":{"status":"connected"' || SMOKE_FAIL="${SMOKE_FAIL}API or database not answering; "
  echo "$h" | grep -q '"scheduler":{"status":"connected"' || SMOKE_FAIL="${SMOKE_FAIL}scheduler unreachable; "
  dc exec -T nginx wget -qO- http://127.0.0.1/login 2>/dev/null | grep -qi '<html' || SMOKE_FAIL="${SMOKE_FAIL}sign-in page did not load; "
  dc exec -T nginx wget -qO- --header 'Content-Type: application/json' --post-data '{"query":"{__typename}"}' http://127.0.0.1/graphql 2>/dev/null \
    | grep -Eq '"(data|errors)"' || SMOKE_FAIL="${SMOKE_FAIL}GraphQL not answering; "
  [ -z "$SMOKE_FAIL" ]
}

# Up to ~2 minutes: containers take a while to come up after a restart.
smoke() {
  for _ in $(seq 1 ${SMOKE_TRIES:-24}); do
    smoke_once && return 0
    sleep "${SMOKE_WAIT:-5}"
  done
  return 1
}

# Restore the database from a backup. The database as it is now is dumped first,
# so nothing written since the backup is lost for good.
restore_db() {
  local file="$1" safety
  safety="$BACKUPS/hr-scoring_$(date +%Y%m%d_%H%M%S)_before-restore.sql"
  (umask 077; dc exec -T postgres pg_dump -U hackathon hackathon > "$safety" 2>/dev/null) \
    && ok "current database saved first → $safety" || warn "could not save the current database first"
  dc stop $SERVICES >/dev/null 2>&1
  dc exec -T postgres psql -U hackathon -d postgres -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS hackathon WITH (FORCE);" -c "CREATE DATABASE hackathon OWNER hackathon;" >/dev/null \
    && dc exec -T postgres psql -U hackathon -d hackathon -v ON_ERROR_STOP=1 -q < "$file" >/dev/null
}

# Put back the previous release: its images, its code, and (if asked) its data.
# Uses only images already on this server; nothing is built or downloaded.
put_back() {
  local restore_data="$1"
  # shellcheck disable=SC1090
  . "$STATE"
  for name in $IMAGES; do
    if ! docker image inspect "$name:rollback" >/dev/null 2>&1; then
      err "no rollback image for $name — cannot put back automatically"
      return 1
    fi
  done
  for name in $IMAGES; do
    docker tag "$name:latest" "$name:failed" 2>/dev/null
    docker tag "$name:rollback" "$name:latest" || return 1
  done
  ok "previous images restored"
  if [ "$restore_data" = 1 ]; then
    if [ -n "$BACKUP" ] && [ -s "$BACKUP" ]; then
      step "restore database from $(basename "$BACKUP")"
      restore_db "$BACKUP" || { err "database restore failed"; return 1; }
      ok "database restored"
    else
      err "no backup recorded for this release"; return 1
    fi
  fi
  git reset -q --hard "$PREVIOUS_COMMIT" || warn "could not reset the code to $PREVIOUS_COMMIT"
  dc up -d --no-build $SERVICES >/dev/null 2>&1 || { err "start failed"; return 1; }
  printf '%s %s\n' "$RELEASE_COMMIT" "$PREVIOUS_COMMIT" > "$BLOCKED"
  save_state "$PREVIOUS_COMMIT" "$PREVIOUS_COMMIT" "" 0 "$IMAGES" 1
  printf '%s  rolled back %s → %s%s\n' "$(date -u +%FT%TZ)" "${RELEASE_COMMIT:0:7}" "${PREVIOUS_COMMIT:0:7}" \
    "$([ "$restore_data" = 1 ] && echo ' (with database)')" >> "$RELEASES/releases.log"
}

# Refuse to deploy a release that was rolled back, unless a later commit reverts it.
check_blocked() {
  local target="$1" bad good
  [ -f "$BLOCKED" ] && [ "$ALLOW_BLOCKED" = 0 ] || return 0
  read -r bad good < "$BLOCKED"
  git merge-base --is-ancestor "$bad" "$target" 2>/dev/null || return 0
  local c
  for c in $(git rev-list "$good..$bad" 2>/dev/null); do
    git log --format=%B "$bad..$target" | grep -q "This reverts commit $c" && return 0
  done
  err "${bad:0:7} was rolled back, and $(git rev-parse --short "$target") still contains it."
  echo "    Revert it first (Actions → patch-kit → Run workflow → roll-back-last-upgrade, or git revert),"
  echo "    or, if the commits since then fix the problem: ./deploy.sh --allow-blocked"
  return 1
}

# ── status ─────────────────────────────────────────────────────────────────

if [ "$MODE" = status ]; then
  step "running"
  git log --oneline -1 | sed 's/^/  code:  /'
  if [ -f "$STATE" ]; then
    # shellcheck disable=SC1090
    . "$STATE"
    echo "  deployed: $RELEASE_AT"
    if [ "$ROLLED_BACK" = 1 ]; then
      echo "  this is a rolled-back release; there is nothing further to roll back to"
    else
      echo "  rollback would put back: $(git log --oneline -1 "$PREVIOUS_COMMIT" 2>/dev/null || echo "$PREVIOUS_COMMIT")"
      if [ "$DB_CHANGED" = 1 ]; then
        echo "  this release changed the database; rolling back needs --with-database"
        echo "  (restores $(basename "$BACKUP"), losing what was saved since)"
      else
        echo "  the database is unchanged by this release; a rollback leaves the data as it is"
      fi
    fi
  else
    echo "  no release recorded yet (the first deploy with this script records one)"
  fi
  [ -f "$BLOCKED" ] && warn "blocked: $(cut -c1-7 "$BLOCKED") was rolled back"
  [ -f "$RELEASES/releases.log" ] && { step "history"; tail -n 10 "$RELEASES/releases.log" | sed 's/^/  /'; }
  exit 0
fi

# ── rollback (a person asked for it) ───────────────────────────────────────

if [ "$MODE" = rollback ]; then
  step "rollback"
  if [ ! -f "$STATE" ]; then err "no release recorded on this server; nothing to roll back to"; exit 1; fi
  # shellcheck disable=SC1090
  . "$STATE"
  if [ "$ROLLED_BACK" = 1 ]; then err "already rolled back to ${PREVIOUS_COMMIT:0:7}; only one step back is kept"; exit 1; fi
  echo "  now running:  $(git log --oneline -1 "$RELEASE_COMMIT" 2>/dev/null) (deployed $RELEASE_AT)"
  echo "  put back:     $(git log --oneline -1 "$PREVIOUS_COMMIT" 2>/dev/null)"
  if [ "$DB_CHANGED" = 1 ] && [ "$WITH_DB" = 0 ]; then
    err "this release changed the database, so the old code can't run on it as it is."
    echo "    ./deploy.sh --rollback --with-database restores $(basename "$BACKUP")"
    echo "    (taken just before the release). Anything saved since then is lost,"
    echo "    although the current database is dumped to backups/ first."
    exit 1
  fi
  [ "$WITH_DB" = 1 ] && warn "the database goes back to $(basename "$BACKUP"); entries saved since then are removed (a copy is kept)"
  if [ "$YES" = 0 ]; then
    read -r -p "  Type ROLLBACK to continue: " answer
    [ "$answer" = "ROLLBACK" ] || { warn "cancelled"; exit 1; }
  fi
  put_back "$WITH_DB" || { alert "HR Scoring: rollback FAILED" "Manual rollback of ${RELEASE_COMMIT:0:7} failed on $(hostname). Check: ./deploy.sh --status"; exit 1; }
  step "check"
  if smoke; then
    ok "previous release is running and passes the checks"
    alert "HR Scoring: rolled back to ${PREVIOUS_COMMIT:0:7}" "A person rolled back ${RELEASE_COMMIT:0:7} on $(hostname). The previous release passes the checks. Revert the change in git before the next deploy."
    echo
    warn "the branch on GitHub still has ${RELEASE_COMMIT:0:7}. Revert it there before the next deploy:"
    echo "    GitHub → Actions → patch-kit → Run workflow → roll-back-last-upgrade (for a patch-kit upgrade)"
    exit 0
  fi
  err "the previous release fails the checks too: $SMOKE_FAIL"
  alert "HR Scoring: rolled back, but still failing" "Rolled back to ${PREVIOUS_COMMIT:0:7} on $(hostname), but: $SMOKE_FAIL"
  exit 1
fi

# A release that was rolled back is refused before any work is done.
if [ "$PULL" = 1 ]; then
  git fetch origin "$BRANCH" --quiet || { err "git fetch failed"; exit 1; }
  check_blocked "origin/$BRANCH" || exit 1
else
  check_blocked HEAD || exit 1
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
  chmod 700 "$BACKUPS"
  BACKUP="$BACKUPS/hr-scoring_$(date +%Y%m%d_%H%M%S).sql"
  # Only root may read backups.
  if (umask 077; dc exec -T postgres pg_dump -U hackathon hackathon > "$BACKUP" 2>/dev/null) && [ -s "$BACKUP" ]; then
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

BEFORE=$(git rev-parse HEAD)
if [ "$PULL" = 1 ]; then
  step "pull $BRANCH"
  git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" "origin/$BRANCH"
  git reset --hard "origin/$BRANCH" --quiet || { err "git reset failed"; exit 1; }
  AFTER=$(git rev-parse HEAD)
  if [ "$BEFORE" = "$AFTER" ]; then warn "already at ${AFTER:0:7}"; else ok "${BEFORE:0:7} → ${AFTER:0:7}"; fi
else
  step "pull skipped"
  AFTER=$(git rev-parse HEAD)
fi
git log --oneline -1 | sed 's/^/  /'

# ── 4. rollback point, then build ──────────────────────────────────────────

# The images running now are kept (tagged :rollback) so a failed release can be
# put back in seconds, with no build and no download.
step "keep the running release as the rollback point"
IMAGES=""
CAN_ROLL_BACK=1
for svc in $SERVICES; do
  if read -r name id < <(image_of "$svc"); then
    name="${name%%:*}"
    docker tag "$id" "$name:rollback" && IMAGES="$IMAGES $name"
  else
    CAN_ROLL_BACK=0
  fi
done
IMAGES="${IMAGES# }"
if [ "$CAN_ROLL_BACK" = 1 ]; then
  ok "kept ${BEFORE:0:7} ($IMAGES)"
else
  warn "not every service is running, so there is no complete rollback point for this deploy"
fi
DB_CHANGED=$(db_changed "$BEFORE" "$AFTER")
[ "$DB_CHANGED" = 1 ] && warn "this release changes the database (apps/api/prisma); a rollback would restore the backup above"

# One at a time. Compose builds in parallel by default, and three builds at
# once next to a live platform is the memory spike this avoids.
for svc in $SERVICES; do
  step "build $svc"
  if ! dc build "$svc"; then
    err "build of $svc failed — nothing has been restarted"
    git reset -q --hard "$BEFORE"
    exit 1
  fi
  ok "$svc built"
done

# ── 5. migrate ─────────────────────────────────────────────────────────────

step "migrate"
if ! dc run --rm api npx prisma migrate deploy; then
  err "migration failed — nothing has been restarted"
  if [ "$DB_CHANGED" = 1 ] && [ -n "$BACKUP" ]; then
    warn "a migration may have half-applied. If the app misbehaves, restore $BACKUP:"
    echo "    ./deploy.sh --status   then   ./deploy.sh --rollback --with-database"
    save_state "$AFTER" "$BEFORE" "$BACKUP" 1 "$IMAGES" 0
  fi
  exit 1
fi
ok "migrations applied"

# ── 6. start ───────────────────────────────────────────────────────────────

step "start"
dc up -d || { err "start failed"; exit 1; }
ok "containers up"
save_state "$AFTER" "$BEFORE" "$BACKUP" "$DB_CHANGED" "$IMAGES" 0

# ── 7. check (and put back automatically if it fails) ─────────────────────

step "check: API, database, scheduler, sign-in page, GraphQL"
if smoke; then
  ok "all checks passed"
  printf '%s  deployed %s (previous %s)%s\n' "$(date -u +%FT%TZ)" "${AFTER:0:7}" "${BEFORE:0:7}" \
    "$([ "$DB_CHANGED" = 1 ] && echo ', database changed')" >> "$RELEASES/releases.log"
  rm -f "$BLOCKED"
  for name in $IMAGES; do docker rmi "$name:failed" >/dev/null 2>&1; done
else
  FAILED_BECAUSE="$SMOKE_FAIL"
  err "check failed: $FAILED_BECAUSE"
  echo; echo "last 30 lines of api log:"
  dc logs --tail=30 api 2>/dev/null | sed 's/^/    /'
  dc ps
  if [ "$CAN_ROLL_BACK" = 0 ] || [ "$BEFORE" = "$AFTER" ]; then
    alert "HR Scoring: deploy check failed" "Deploy of ${AFTER:0:7} on $(hostname) failed the check ($FAILED_BECAUSE). There was no previous release to put back."
    exit 1
  fi
  step "putting back ${BEFORE:0:7} automatically"
  if put_back "$DB_CHANGED" && smoke; then
    ok "previous release restored and passing the checks"
    alert "HR Scoring: deploy rolled back automatically" \
      "Deploy of ${AFTER:0:7} on $(hostname) failed the check ($FAILED_BECAUSE), so ${BEFORE:0:7} was put back$([ "$DB_CHANGED" = 1 ] && echo ', with the database from just before the deploy'). It passes the checks. The failed images are tagged :failed for investigation. The next deploy is refused until the change is fixed or reverted."
    exit 2
  fi
  err "automatic rollback did not recover the app: $SMOKE_FAIL"
  alert "HR Scoring: DOWN — automatic rollback failed" "Deploy of ${AFTER:0:7} on $(hostname) failed ($FAILED_BECAUSE), and putting back ${BEFORE:0:7} did not recover it ($SMOKE_FAIL). Needs a person now. Backup: ${BACKUP:-none}"
  exit 1
fi

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
echo "  ./deploy.sh --status shows what a rollback would put back"
