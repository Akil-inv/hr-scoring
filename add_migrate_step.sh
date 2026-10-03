#!/usr/bin/env bash
#
# Insert a `prisma migrate deploy` step into deploy.sh, between build and
# restart.
#
#   bash add_migrate_step.sh
#   bash add_migrate_step.sh --revert
#
# Why there specifically:
#
#   After the build, because `docker-compose run api` uses the image — running
#   it against a stale image finds no new migration files, applies nothing, and
#   reports success. That is not a hypothetical: it happened once already.
#
#   Before the restart, because the new code writes columns the old schema does
#   not have. A failure leaves the old containers serving, which is the same
#   posture the build step already takes.

set -uo pipefail

TARGET="deploy.sh"
BAK="deploy.sh.bak"
MARKER="prisma migrate deploy"

if [ ! -f "$TARGET" ]; then
  echo "not found: $TARGET — run this from the repo root on EC2"
  exit 2
fi

if [ "${1:-}" = "--revert" ]; then
  if [ ! -f "$BAK" ]; then echo "no backup at $BAK"; exit 2; fi
  cp "$BAK" "$TARGET"
  echo "restored $TARGET"
  exit 0
fi

if grep -q "$MARKER" "$TARGET"; then
  echo "migrate step already present — nothing to do"
  exit 0
fi

ANCHOR='# ── 5. restart ──'
if ! grep -q -- "$ANCHOR" "$TARGET"; then
  echo "anchor not found: $ANCHOR"
  echo "deploy.sh has changed; paste it and it can be re-anchored."
  exit 1
fi

cp "$TARGET" "$BAK"

python3 - "$TARGET" <<'PY'
import sys

path = sys.argv[1]
src = open(path).read()

anchor = "# ── 5. restart ──"
i = src.index(anchor)

block = '''# ── 4b. migrate ─────────────────────────────────────────────────────────────

# After the build so the image contains the migration files, and before the
# restart so the new code never starts against an old schema.
step "migrate"
if ! docker-compose run --rm api npx prisma migrate deploy; then
  err "migration failed — nothing has been restarted, the old containers are still serving"
  exit 1
fi
ok "migrations applied"

'''

open(path, "w").write(src[:i] + block + src[i:])
PY

if ! grep -q "$MARKER" "$TARGET"; then
  cp "$BAK" "$TARGET"
  echo "verification failed, reverted"
  exit 1
fi

bash -n "$TARGET" || { cp "$BAK" "$TARGET"; echo "syntax check failed, reverted"; exit 1; }

echo "inserted the migrate step into $TARGET"
echo "backup at $BAK"
echo
echo "next:  ./deploy.sh"
