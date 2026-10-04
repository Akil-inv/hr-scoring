#!/usr/bin/env bash
# Field-encryption commands for whoever runs production. Run in this folder
# on the server. Guide: docs/FIELD-ENCRYPTION.md
#
#   ./encryption.sh status              what protects the data, how much is encrypted
#   ./encryption.sh check               unlock the key as the app would; says if it works
#   ./encryption.sh recovery-kit        print the recovery key for the safe
#   ./encryption.sh break-glass         start the app on the recovery key (KMS unavailable)
#   ./encryption.sh restore-kms         back on KMS after a break-glass start
#   ./encryption.sh move-to-kms KEY     protect the key with another KMS key (alias or ARN)
#   ./encryption.sh decrypt-all         switch encryption off: everything stored plain again
set -euo pipefail
cd "$(dirname "$0")"

if command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else DC="docker compose"; fi
cli() { $DC run --rm --no-deps -T api node dist/crypto/cli.js "$@"; }

backup_env() {  # a dated copy of .env, never including the recovery key
  grep -v '^FIELD_ENCRYPTION_KEY=' .env > ".env.bak.$(date +%Y%m%d%H%M%S)" || true
  chmod 600 .env.bak.* 2>/dev/null || true
}
env_set() {   # env_set NAME VALUE: replace or add a line in .env, keeping a backup
  backup_env
  grep -v "^$1=" .env > .env.tmp || true
  printf '%s=%s\n' "$1" "$2" >> .env.tmp
  mv .env.tmp .env
  chmod 600 .env
}
env_unset() {
  backup_env
  grep -v "^$1=" .env > .env.tmp || true
  mv .env.tmp .env
  chmod 600 .env
}
restart_api() {
  $DC up -d --no-deps api
  echo "Waiting for the app to start…"
  for _ in $(seq 1 30); do
    sleep 3
    cid=$($DC ps -q api)
    state=$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)
    if [ "$state" = "healthy" ]; then
      echo "Started."
      $DC logs --tail 30 api | grep -i "encrypt\|break glass\|KMS" || true
      return 0
    fi
  done
  echo "The app did not report healthy. Its last messages:"
  $DC logs --tail 40 api
  return 1
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  status|check|recovery-kit)
    cli "$cmd" "$@"
    ;;

  move-to-kms)
    [ -n "${1:-}" ] || { echo "Usage: ./encryption.sh move-to-kms alias/hr-scoring"; exit 1; }
    cli move-to-kms "$1"
    env_set KMS_KEY_ID "$1"
    env_unset FIELD_ENCRYPTION_KEY
    restart_api
    ;;

  break-glass)
    echo "Break glass: start the app on the recovery key, without AWS KMS."
    echo "Paste the recovery key (HRK-v1-…). It is not shown as you type."
    read -r -s -p "Recovery key: " key; echo
    [ -n "$key" ] || { echo "No key given."; exit 1; }
    FIELD_ENCRYPTION_KEY="$key" $DC run --rm --no-deps -T -e FIELD_ENCRYPTION_KEY api node dist/crypto/cli.js check \
      || { echo "That key does not open this data. Nothing was changed."; exit 1; }
    env_set FIELD_ENCRYPTION_KEY "$key"
    restart_api
    echo
    echo "Running on the recovery key. When KMS works again: ./encryption.sh restore-kms"
    ;;

  restore-kms)
    kms=$(grep '^KMS_KEY_ID=' .env | cut -d= -f2- || true)
    [ -n "$kms" ] || { echo "Set KMS_KEY_ID in .env first (the KMS key alias or ARN)."; exit 1; }
    cli move-to-kms "$kms"
    env_unset FIELD_ENCRYPTION_KEY
    restart_api
    echo "Back on AWS KMS. The recovery key is out of .env; keep the printed kit in the safe."
    ;;

  decrypt-all)
    echo "This switches encryption OFF: the app stops for a minute, every value is"
    echo "stored unencrypted again, the key is removed and the app restarts."
    echo "Take a backup first if you have not."
    read -r -p "Type DECRYPT to continue: " ok
    [ "$ok" = "DECRYPT" ] || { echo "Cancelled."; exit 1; }
    $DC stop api web
    if cli decrypt-all --yes; then
      env_unset KMS_KEY_ID
      env_unset FIELD_ENCRYPTION_KEY
      $DC up -d
      echo "Encryption is off. To turn it on again: set KMS_KEY_ID in .env and deploy."
    else
      echo "Not finished; nothing was removed. Starting the app again as it was."
      $DC up -d
      exit 1
    fi
    ;;

  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
