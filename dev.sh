#!/usr/bin/env bash
#
# Local development services, backgrounded.
#
#   ./dev.sh start     start postgres, scheduler, api, web
#   ./dev.sh stop      stop everything (leaves postgres running)
#   ./dev.sh restart   stop then start
#   ./dev.sh status    what is running, and on which ports
#   ./dev.sh logs      tail all three logs together
#   ./dev.sh logs api  tail one
#
# Logs go to .dev-logs/. Processes survive closing the terminal.
#
# Why this exists: services kept dying because commands were typed into the
# tab running them, or the tab was closed. Backgrounding with nohup means
# there is nothing to accidentally Ctrl+C.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/.dev-logs"
PIDS="$LOGS/pids"

mkdir -p "$LOGS" "$PIDS"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

ok()   { echo "${GRN}✓${OFF} $*"; }
warn() { echo "${YEL}!${OFF} $*"; }
err()  { echo "${RED}✗${OFF} $*"; }
dim()  { echo "${DIM}$*${OFF}"; }

port_pid() { lsof -nP -sTCP:LISTEN -ti:"$1" 2>/dev/null | head -1; }

wait_for_port() {
  local port=$1 tries=${2:-40}
  for _ in $(seq 1 "$tries"); do
    if [ -n "$(port_pid "$port")" ]; then return 0; fi
    sleep 1
  done
  return 1
}

# ── postgres ────────────────────────────────────────────────────────────────

start_postgres() {
  if docker compose ps postgres 2>/dev/null | grep -q healthy; then
    ok "postgres already healthy on 5555"
    return 0
  fi
  echo "starting postgres..."
  docker compose up postgres -d >/dev/null 2>&1
  for _ in $(seq 1 30); do
    if docker compose ps postgres 2>/dev/null | grep -q healthy; then
      ok "postgres healthy on 5555"
      return 0
    fi
    sleep 1
  done
  err "postgres did not become healthy — check: docker compose ps"
  return 1
}

# ── generic service launcher ────────────────────────────────────────────────

start_service() {
  local name=$1 port=$2 dir=$3 cmd=$4
  local log="$LOGS/$name.log" pidfile="$PIDS/$name.pid"

  local existing
  existing=$(port_pid "$port")
  if [ -n "$existing" ]; then
    warn "$name already listening on $port (pid $existing) — leaving it alone"
    return 0
  fi

  echo "starting $name..."
  : > "$log"
  ( cd "$dir" && nohup bash -c "$cmd" >> "$log" 2>&1 & echo $! > "$pidfile" )

  if wait_for_port "$port"; then
    ok "$name on $port  ${DIM}($log)${OFF}"
  else
    err "$name failed to start — last lines:"
    tail -15 "$log" | sed 's/^/    /'
    return 1
  fi
}

stop_service() {
  local name=$1 port=$2 pattern=$3
  local pid
  pid=$(port_pid "$port")
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    sleep 1
    pid=$(port_pid "$port")
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  fi
  pkill -f "$pattern" 2>/dev/null
  rm -f "$PIDS/$name.pid"
  ok "$name stopped"
}

# ── commands ────────────────────────────────────────────────────────────────

cmd_start() {
  start_postgres || return 1

  start_service scheduler 8001 "$ROOT/apps/scheduler" \
    "source .venv/bin/activate && uvicorn src.main:app --port 8001"

  start_service api 4000 "$ROOT/apps/api" \
    "npm run start:dev"

  start_service web 3000 "$ROOT/apps/web" \
    "npm run dev"

  echo
  cmd_status
  echo
  dim "logs:  ./dev.sh logs        stop:  ./dev.sh stop"
}

cmd_stop() {
  stop_service web 3000 "next dev"
  stop_service api 4000 "nest start"
  stop_service scheduler 8001 "uvicorn"
  dim "postgres left running — docker compose stop postgres to stop it too"
}

cmd_status() {
  local any=0
  for entry in "scheduler 8001" "api 4000" "web 3000"; do
    set -- $entry
    local name=$1 port=$2 pid
    pid=$(port_pid "$port")
    if [ -n "$pid" ]; then
      ok "$name  ${DIM}:$port  pid $pid${OFF}"
      any=1
    else
      err "$name  ${DIM}:$port  not running${OFF}"
    fi
  done

  if docker compose ps postgres 2>/dev/null | grep -q healthy; then
    ok "postgres  ${DIM}:5555  healthy${OFF}"
  else
    err "postgres  ${DIM}:5555  not healthy${OFF}"
  fi

  if [ "$any" = 1 ]; then
    echo
    curl -s --max-time 3 http://localhost:4000/health >/dev/null 2>&1 \
      && ok "api health responding" \
      || warn "api health not responding yet"
  fi
}

cmd_logs() {
  local which=${1:-all}
  case "$which" in
    all) tail -f "$LOGS"/scheduler.log "$LOGS"/api.log "$LOGS"/web.log ;;
    *)   tail -f "$LOGS/$which.log" ;;
  esac
}

cmd_build() {
  echo "building api..."
  ( cd "$ROOT/apps/api" && rm -rf dist && npx nest build ) || { err "api build failed"; return 1; }
  ok "api built"

  echo "building web..."
  ( cd "$ROOT/apps/web" && rm -rf .next && npm run build >/dev/null ) || { err "web build failed"; return 1; }
  ok "web built"
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; echo; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs "${2:-all}" ;;
  build)   cmd_build ;;
  *)
    echo "usage: ./dev.sh {start|stop|restart|status|logs [api|web|scheduler]|build}"
    exit 1
    ;;
esac
