#!/bin/bash
# Optional tmux-crash watchdog; install-watchdog.sh installs it as a 30 s launchd job.
#
# Records the tmux server PID while the base session is healthy. If the socket
# disappears while that server still runs, sends SIGUSR1 so tmux recreates it.
# The signal goes only to a process that lsof shows holding this socket.
# Restarts Agentboard only when the base session is gone and no live recorded
# server could be recovered.
#
# Settings follow the service: TMUX_SESSION, AGENTBOARD_DATA_DIR,
# AGENTBOARD_TMUX_PID_FILE and TMUX_TMPDIR come from this job's environment
# when set, else from the service plist's EnvironmentVariables (which, in
# release mode, include ~/.agentboard/service-env.json), else the server's
# defaults. A relative data directory or PID file is resolved against the
# service's WorkingDirectory, as the server does. A relative TMUX_TMPDIR is
# refused: tmux resolves it against each client's own directory.
set -u

LABEL="com.agentboard"
SERVICE_PLIST="${AGENTBOARD_SERVICE_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"

# launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no
# tmux. install-watchdog.sh puts the detected tmux directory first; the
# Homebrew prefixes (Apple Silicon, then Intel) are a fallback (overridable
# so tests can keep a real tmux out of reach).
export PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
TMUX_FALLBACK_PATH="${AGENTBOARD_TMUX_FALLBACK_PATH-/opt/homebrew/bin:/usr/local/bin}"
# An empty fallback must not leave a trailing ":" (the current directory) on PATH.
if [ -n "$TMUX_FALLBACK_PATH" ]; then PATH="$PATH:$TMUX_FALLBACK_PATH"; fi
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

# The server resolves a relative path against its working directory.
service_path() {
  local value="$1" cwd=""
  case "$value" in
    /*) ;;
    *) if [ -f "$SERVICE_PLIST" ] && command -v plutil >/dev/null 2>&1; then
         cwd="$(plutil -extract WorkingDirectory raw -o - "$SERVICE_PLIST" 2>/dev/null || true)"
       fi
       value="${cwd:-$HOME}/$value" ;;
  esac
  printf '%s' "$value"
}

SESSION="$(setting TMUX_SESSION)"
SESSION="${SESSION:-agentboard}"
DATA_DIR="$(trim "$(setting AGENTBOARD_DATA_DIR)")"
DATA_DIR="$(service_path "${DATA_DIR:-$HOME/.agentboard}")"
PID_FILE="$(setting AGENTBOARD_TMUX_PID_FILE)"
PID_FILE="$(service_path "${PID_FILE:-$DATA_DIR/tmux-server.pid}")"
TMUX_TMPDIR_VALUE="$(setting TMUX_TMPDIR)"
if [ -n "$TMUX_TMPDIR_VALUE" ]; then
  case "$TMUX_TMPDIR_VALUE" in
    /*) ;;
    *) # Probing a guessed directory could reach no server, or another one,
       # and restart Agentboard every 30 seconds.
       echo "TMUX_TMPDIR must be an absolute path, got '$TMUX_TMPDIR_VALUE'; not probing or restarting anything" >&2
       exit 1 ;;
  esac
  # tmux ignores a TMUX_TMPDIR that does not exist and falls back to the
  # default socket, which is a different tmux server. The directory can be
  # missing after a reboot clears /tmp, before the service recreates it.
  # Create it, as the server does, so every probe targets the right socket.
  # shellcheck disable=SC2174 # Mode on the leaf only is intended, as in the server.
  if ! mkdir -p -m 700 "$TMUX_TMPDIR_VALUE"; then
    echo "Cannot create TMUX_TMPDIR $TMUX_TMPDIR_VALUE; not probing another tmux server" >&2
    exit 1
  fi
  export TMUX_TMPDIR="$TMUX_TMPDIR_VALUE"
fi

# The socket that tmux uses for this service: <dir>/tmux-<uid>/default, with
# the directory resolved through symlinks (/tmp is /private/tmp on macOS).
socket_path() {
  local base
  base="$(cd "${TMUX_TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 1
  printf '%s/tmux-%s/default' "$base" "$(id -u)"
}

# Classify a live process named tmux: "ours" when it holds the service's
# socket (lsof still reports the bound path after the socket file is
# removed), "other" when lsof lists its sockets and ours is not among them,
# "unknown" when lsof reports nothing.
tmux_server_identity() {
  local pid="$1" socket open
  socket="$(socket_path)" || { echo unknown; return; }
  open="$(lsof -a -p "$pid" -U -Fn 2>/dev/null || true)"
  if [ -z "$open" ]; then
    echo unknown
  elif printf '%s\n' "$open" | grep -Fqx "n$socket"; then
    echo ours
  else
    echo other
  fi
}

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
  # The recorded PID can belong to another tmux process after PID reuse, so
  # signal it only when it holds this service's socket.
  case "$(tmux_server_identity "$pid")" in
    ours)
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
      exit 1 ;;
    other)
      echo "Recorded PID $pid is a tmux process that does not hold this service's socket; not signaling it" >&2 ;;
    *)
      echo "Cannot tell whether tmux process $pid holds this service's socket (lsof reported nothing); not signaling it and not restarting Agentboard" >&2
      exit 1 ;;
  esac
fi

restart_agentboard
