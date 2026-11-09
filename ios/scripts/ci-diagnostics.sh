#!/bin/bash
# Source from CI scripts. Phase stdout stays available for command substitution.
ci_snapshot() {
  {
    printf '\n=== %s phase=%s ===\n' "$(date -u +%FT%TZ)" "${1:-periodic}"
    uptime
    ps -Ao pid,ppid,%cpu,%mem,rss,etime,comm | sort -k3 -nr | head -25
    if command -v vm_stat >/dev/null 2>&1; then vm_stat; fi
  } >> "$CI_DIAGNOSTICS_PATH/resources.log" 2>&1 || true
}

ci_diagnostics_start() {
  CI_DIAGNOSTICS_PATH="${IOS_CI_DIAGNOSTICS_DIR:-/tmp/ab-ios-diagnostics}/$1-$$"
  export CI_DIAGNOSTICS_PATH
  mkdir -p "$CI_DIAGNOSTICS_PATH"
  {
    printf 'ImageOS=%s\nImageVersion=%s\nDEVELOPER_DIR=%s\n' "${ImageOS:-unknown}" "${ImageVersion:-unknown}" "${DEVELOPER_DIR:-}"
    printf 'CoreSimulatorVersion='
    /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist 2>/dev/null || printf 'unknown\n'
  } > "$CI_DIAGNOSTICS_PATH/environment.txt"
  printf 'phase\tstarted_utc\tduration_seconds\texit_status\n' > "$CI_DIAGNOSTICS_PATH/phases.tsv"
  ci_snapshot start
  # Sleep is a child we explicitly reap when the sampler is stopped.
  (
    sampler_sleep=
    trap 'kill "$sampler_sleep" 2>/dev/null || true; exit 0' TERM INT
    while :; do
      sleep "${IOS_CI_SAMPLE_INTERVAL:-30}" & sampler_sleep=$!
      wait "$sampler_sleep" || exit 0
      ci_snapshot periodic
    done
  ) &
  CI_DIAGNOSTICS_PID=$!
}

ci_diagnostics_stop() {
  if [ -n "${CI_DIAGNOSTICS_PID:-}" ]; then
    kill "$CI_DIAGNOSTICS_PID" 2>/dev/null || true
    wait "$CI_DIAGNOSTICS_PID" 2>/dev/null || true
    unset CI_DIAGNOSTICS_PID
    ci_snapshot stop
  fi
  return 0
}

ci_phase() (
  set -e
  # The EXIT trap records failures without wrapping the command in an if, which
  # would disable errexit inside shell functions. State changes stay local.
  # Bash 3.2 unwinds function locals before its EXIT trap on errexit. These
  # variables belong to this subshell so the trap retains them on every path.
  phase=$1 started=$SECONDS started_utc=
  shift
  started_utc=$(date -u +%FT%TZ)
  trap 'status=$?; duration=$((SECONDS - started)); printf "%s\t%s\t%s\t%s\n" "$phase" "$started_utc" "$duration" "$status" >> "$CI_DIAGNOSTICS_PATH/phases.tsv"; printf "[ios-ci] %s: %ss (exit %s)\n" "$phase" "$duration" "$status" >&2; ci_snapshot "$phase:end"; exit "$status"' EXIT
  printf '[ios-ci] %s: starting %s\n' "$phase" "$started_utc" >&2
  ci_snapshot "$phase:start"
  "$@"
)
