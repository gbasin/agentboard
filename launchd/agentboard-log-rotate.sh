#!/bin/bash
# Rotate Agentboard's logs; install-logrotate.sh installs this into ~/.agentboard/bin.
#
# Uses copytruncate: the server opens its log once in append mode and never
# reopens it, so a rename would leave it writing to the rotated file.
#
# The log path follows the server's own resolution (src/server/config.ts):
# LOG_FILE if set (an empty value disables file logging), else
# $AGENTBOARD_DATA_DIR/agentboard.log, else ~/.agentboard/agentboard.log.
# Under launchd, the service's environment lives in its plist, for both
# source and release installs (release mode merges service-env.json into the
# plist), so read the values from there. The launchd stdout/stderr capture
# paths also come from that plist.
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
SERVICE_PLIST="${AGENTBOARD_SERVICE_PLIST:-$HOME/Library/LaunchAgents/com.agentboard.plist}"
MAX_BYTES=$((50 * 1024 * 1024))
KEEP=5

# Print a plist value and succeed, or fail when the key (or plist) is absent.
plist_value() {
    [ -f "$SERVICE_PLIST" ] || return 1
    plutil -extract "$1" raw -o - "$SERVICE_PLIST" 2>/dev/null
}

# Expand a leading ~/ the way the logger does for LOG_FILE. The server does
# not expand ~ in AGENTBOARD_DATA_DIR, so that value must not pass through here.
expand_home() {
    local value="$1"
    # shellcheck disable=SC2088 # Matching a literal "~/", as the logger does.
    case "$value" in
        "~/"*) value="$HOME/${value#"~/"}" ;;
    esac
    printf '%s\n' "$value"
}

# Make a relative path relative to the service's working directory, which is
# where the server resolves it.
resolve_path() {
    local value="$1" cwd
    case "$value" in
        /*) ;;
        *) cwd="$(plist_value WorkingDirectory || printf '%s' "$HOME")"
           value="$cwd/$value" ;;
    esac
    printf '%s\n' "$value"
}

app_log() {
    local value data_dir
    if value="$(plist_value EnvironmentVariables.LOG_FILE)"; then
        [ -n "$value" ] || return 0 # Empty LOG_FILE: file logging is off.
        resolve_path "$(expand_home "$value")"
        return 0
    fi
    data_dir="$(plist_value EnvironmentVariables.AGENTBOARD_DATA_DIR || true)"
    # The server trims this value and ignores it when blank.
    data_dir="${data_dir#"${data_dir%%[![:space:]]*}"}"
    data_dir="${data_dir%"${data_dir##*[![:space:]]}"}"
    if [ -n "$data_dir" ]; then
        printf '%s/agentboard.log\n' "$(resolve_path "$data_dir")"
    else
        printf '%s/.agentboard/agentboard.log\n' "$HOME"
    fi
}

capture_log() {
    plist_value "$1" || printf '%s/.agentboard/%s\n' "$HOME" "$2"
}

rotate_if_large() {
    local log="$1"
    [ -n "$log" ] && [ -f "$log" ] || return 0
    local size
    size=$(stat -f%z "$log" 2>/dev/null || echo 0)
    [ "$size" -ge "$MAX_BYTES" ] || return 0

    rm -f "$log.$KEEP.gz"
    for i in $(seq $((KEEP - 1)) -1 1); do
        if [ -f "$log.$i.gz" ]; then mv "$log.$i.gz" "$log.$((i+1)).gz"; fi
    done

    cp "$log" "$log.1"
    : > "$log"
    gzip -f "$log.1"
}

paths() {
    app_log
    capture_log StandardOutPath launchd.out.log
    capture_log StandardErrorPath launchd.err.log
}

if [ "${1:-}" = "--print-paths" ]; then
    paths
    exit 0
fi

# Rotate each distinct file once (stdout and stderr may share a path).
paths | awk 'NF && !seen[$0]++' | while IFS= read -r log; do
    rotate_if_large "$log"
done
