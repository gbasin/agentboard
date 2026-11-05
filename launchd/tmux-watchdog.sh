#!/bin/bash
# Optional tmux-crash watchdog; install-watchdog.sh installs it as a 30 s launchd job.
#
# Records the tmux server PID while the base session is healthy. If the socket
# disappears while that server still runs, sends SIGUSR1 so tmux recreates it.
# Restarts Agentboard only when the base session is gone and no live recorded
# server could be recovered.
#
# Settings follow the service: TMUX_SESSION, AGENTBOARD_DATA_DIR,
# AGENTBOARD_TMUX_PID_FILE and TMUX_TMPDIR come from this job's environment
# when set, else from the service plist's EnvironmentVariables (which, in
# release mode, include ~/.agentboard/service-env.json), else the server's
# defaults.
set -u

LABEL="com.agentboard"
SERVICE_PLIST="${AGENTBOARD_SERVICE_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"

# launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no
# tmux. install-watchdog.sh puts the detected tmux directory first; the
# Homebrew prefixes (Apple Silicon, then Intel) are a fallback (overridable
# so tests can keep a real tmux out of reach).
export PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}:${AGENTBOARD_TMUX_FALLBACK_PATH-/opt/homebrew/bin:/usr/local/bin}"
# A TMUX value from a calling pane would override TMUX_TMPDIR.
unset TMUX TMUX_PANE

if ! command -v tmux >/dev/null 2>&1; then
  # Without tmux every probe fails; restarting Agentboard would not help.
  echo "tmux not found in PATH ($PATH); not restarting Agentboard" >&2
  exit 1
fi

# Print a setting from this job's environment, else from the service plist.
setting() {
  local name="$1"
  if [ -n "${!name:-}" ]; then
    printf '%s' "${!name}"
  elif [ -f "$SERVICE_PLIST" ] && command -v plutil >/dev/null 2>&1; then
    plutil -extract "EnvironmentVariables.$name" raw -o - "$SERVICE_PLIST" 2>/dev/null || true
  fi
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

SESSION="$(setting TMUX_SESSION)"
SESSION="${SESSION:-agentboard}"
DATA_DIR="$(trim "$(setting AGENTBOARD_DATA_DIR)")"
DATA_DIR="${DATA_DIR:-$HOME/.agentboard}"
PID_FILE="$(setting AGENTBOARD_TMUX_PID_FILE)"
PID_FILE="${PID_FILE:-$DATA_DIR/tmux-server.pid}"
TMUX_TMPDIR_VALUE="$(setting TMUX_TMPDIR)"
if [ -n "$TMUX_TMPDIR_VALUE" ]; then export TMUX_TMPDIR="$TMUX_TMPDIR_VALUE"; fi

restart_agentboard() {
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  exit $?
}

remember_server() {
  local pid temp
  pid="$(tmux display-message -p -t "=$SESSION" '#{pid}')" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  mkdir -p "$(dirname "$PID_FILE")"
  temp="$PID_FILE.$$.tmp"
  (umask 077; printf '%s\n' "$pid" > "$temp")
  mv "$temp" "$PID_FILE"
}

if tmux has-session -t "=$SESSION" 2>/dev/null; then
  remember_server
  exit 0
fi

# The server is reachable but only the managed base session is missing.
# Restart Agentboard so ensureSession() recreates it; no socket repair signal
# is needed.
if tmux list-sessions >/dev/null 2>&1; then
  restart_agentboard
fi

if read -r pid < "$PID_FILE" 2>/dev/null &&
   [[ "$pid" =~ ^[0-9]+$ ]] &&
   kill -0 "$pid" 2>/dev/null &&
   [[ "$(basename "$(ps -p "$pid" -o comm= 2>/dev/null)")" == tmux ]]; then
  kill -USR1 "$pid"
  sleep 0.2
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    remember_server
    exit 0
  fi
  if tmux list-sessions >/dev/null 2>&1; then
    restart_agentboard
  fi
  echo "Live tmux server $pid did not recreate its socket; refusing to replace it" >&2
  exit 1
fi

restart_agentboard
