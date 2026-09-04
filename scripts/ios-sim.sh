#!/usr/bin/env bash
# Drive agentboard in the iOS Simulator for touch/selection QA.
#
# Runs an agentboard instance isolated from the live one (its own tmux server,
# port, DB and log) and drives real touch gestures through idb. Use it to test
# iOS-only behaviour that headless browsers cannot reproduce: native long-press
# text selection, the selection callout, and the on-screen keyboard.
#
# Requirements:
#   Xcode with an iOS runtime, and idb (`pipx install fb-idb`).
#   idb needs a Python whose pyexpat works; reinstall with
#   `pipx reinstall fb-idb --python $(which python3.13)` if it fails to import.
#
# Usage:
#   scripts/ios-sim.sh up            # build, start isolated server, boot sim, open app
#   scripts/ios-sim.sh shot out.png  # screenshot the simulator
#   scripts/ios-sim.sh tap X Y       # tap at device points
#   scripts/ios-sim.sh press X Y [S] # long-press (default 1.5s) at device points
#   scripts/ios-sim.sh swipe X1 Y1 X2 Y2 [S]
#   scripts/ios-sim.sh down          # tear down server and tmux, leave sim booted
#   scripts/ios-sim.sh sim-down      # shut the simulator down
#
# Coordinates are device POINTS, not pixels. A screenshot of an iPhone 17 Pro is
# 1206x2622 px for a 402x874 pt screen, so divide screenshot pixels by 3.

set -euo pipefail

DEVICE="${IOS_SIM_DEVICE:-iPhone 17 Pro}"
PORT="${IOS_SIM_PORT:-4055}"
SESSION="${IOS_SIM_TMUX_SESSION:-iossel}"
# Keep this path short: the tmux unix socket path limit is ~104 chars.
TMPDIR_TMUX="${IOS_SIM_TMUX_TMPDIR:-/tmp/absel}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PATH="$HOME/.local/bin:$PATH"

# The live agentboard exports AGENTBOARD_STATIC_DIR pointing at the *published*
# npm bundle. Every shell spawned inside an agentboard tmux inherits it, which
# makes a locally started server silently serve stale client code. Always pin it.
run_isolated() {
  env -u TMUX -u AGENTBOARD_STATIC_DIR \
    TMUX_TMPDIR="$TMPDIR_TMUX" \
    "$@"
}

udid() {
  # Prefer an already-booted match so repeated commands keep hitting the same
  # simulator when several runtimes expose the same device name.
  local matches
  matches="$(xcrun simctl list devices available | grep -F "$DEVICE (")"
  printf '%s\n' "$matches" \
    | grep -F "(Booted)" \
    | head -1 \
    | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/' \
    | grep . && return 0
  printf '%s\n' "$matches" \
    | head -1 \
    | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/'
}

cmd_up() {
  mkdir -p "$TMPDIR_TMUX"

  echo "==> building client"
  (cd "$REPO" && env -u AGENTBOARD_STATIC_DIR bun run build >/dev/null)

  if ! run_isolated tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "==> creating isolated tmux session '$SESSION'"
    run_isolated tmux new-session -d -s "$SESSION" -x 100 -y 30
  fi
  # Guard against the classic failure: if TMUX_TMPDIR was ignored we would be
  # driving the user's live tmux server instead of an isolated one.
  local count
  count="$(run_isolated tmux list-sessions -F '#{session_name}' | wc -l | tr -d ' ')"
  if [ "$count" != "1" ]; then
    echo "refusing to continue: expected 1 session on the isolated tmux server, found $count" >&2
    echo "(TMUX_TMPDIR=$TMPDIR_TMUX was likely ignored — is the directory present?)" >&2
    exit 1
  fi

  if ! curl -sf -o /dev/null "http://localhost:$PORT/"; then
    echo "==> starting agentboard on :$PORT"
    run_isolated \
      PORT="$PORT" \
      TMUX_SESSION="$SESSION" \
      DISCOVER_PREFIXES="$SESSION" \
      AGENTBOARD_DB_PATH="$TMPDIR_TMUX/ab.db" \
      LOG_FILE="$TMPDIR_TMUX/ab.log" \
      AGENTBOARD_STATIC_DIR="$REPO/dist/client" \
      bun "$REPO/src/server/index.ts" >"$TMPDIR_TMUX/server.out" 2>&1 &
    # Remembered for `down`: env assignments are not in the process's argv,
    # so a pkill -f pattern on them never matches.
    echo $! >"$TMPDIR_TMUX/server.pid"
    for _ in $(seq 1 30); do
      curl -sf -o /dev/null "http://localhost:$PORT/" && break
      sleep 1
    done
  fi

  local id
  id="$(udid)"
  [ -n "$id" ] || { echo "no simulator matching '$DEVICE'" >&2; exit 1; }
  xcrun simctl boot "$id" 2>/dev/null || true
  open -a Simulator
  sleep 5
  xcrun simctl openurl "$id" "http://localhost:$PORT/"
  echo "==> $DEVICE ($id) -> http://localhost:$PORT/"
  echo "    Web Inspector: Safari > Develop > Simulator > localhost"
}

cmd_down() {
  # Kill the server we started (pid file), then anything else still holding
  # the port, and wait until the port is actually free so a following `up`
  # never reuses a server that is still shutting down.
  local pids=""
  if [ -f "$TMPDIR_TMUX/server.pid" ]; then
    pids="$(cat "$TMPDIR_TMUX/server.pid")"
    rm -f "$TMPDIR_TMUX/server.pid"
  fi
  pids="$pids $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -n "${pids// /}" ] && kill $pids 2>/dev/null || true
  local i
  for i in $(seq 1 50); do
    lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    [ "$i" -eq 30 ] && kill -9 $pids 2>/dev/null || true
    sleep 0.1
  done
  if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "warning: something is still listening on :$PORT" >&2
  fi
  run_isolated tmux kill-server 2>/dev/null || true
  echo "==> torn down (simulator left booted; \`$0 sim-down\` shuts it down)"
}

cmd_sim_down() {
  local id
  id="$(udid)"
  [ -n "$id" ] || { echo "no simulator matching '$DEVICE'" >&2; exit 1; }
  xcrun simctl shutdown "$id" 2>/dev/null || true
  echo "==> simulator $DEVICE shut down"
}

main() {
  local sub="${1:-up}"; shift || true
  case "$sub" in
    up)    cmd_up ;;
    down)  cmd_down ;;
    sim-down) cmd_sim_down ;;
    shot)  xcrun simctl io "$(udid)" screenshot "${1:-/tmp/absel/shot.png}" ;;
    tap)   IDB_UDID="$(udid)" idb ui tap "$1" "$2" ;;
    press) IDB_UDID="$(udid)" idb ui tap "$1" "$2" --duration "${3:-1.5}" ;;
    swipe) IDB_UDID="$(udid)" idb ui swipe "$1" "$2" "$3" "$4" --duration "${5:-0.4}" ;;
    *)     sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 1 ;;
  esac
}

main "$@"
