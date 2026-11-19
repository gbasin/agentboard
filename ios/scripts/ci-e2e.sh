#!/bin/bash
# Disposable CI host only. Never reuse an existing private fixture directory.
set -euo pipefail
cd "$(dirname "$0")/../.."
mode=${IOS_E2E_MODE:-all}
shard=${IOS_E2E_SHARD:-all}
case "$mode" in all|light|dark) ;; *) echo "Invalid IOS_E2E_MODE" >&2; exit 2 ;; esac
fixtures=$(bun ios/scripts/e2e-fixtures.ts "$mode" "$shard")
needs() { [[ $'\n'"$fixtures"$'\n' == *$'\n'"$1"$'\n'* ]]; }
source ios/scripts/ci-diagnostics.sh
source ios/scripts/ci-readiness.sh
ci_diagnostics_start "$mode-$shard"
trap ci_diagnostics_stop EXIT
if [ -z "${IOS_TEST_PRODUCTS_DIR:-}" ]; then ci_phase build ./ios/scripts/build-for-testing.sh; fi
export IOS_TEST_PRODUCTS_DIR=${IOS_TEST_PRODUCTS_DIR:-ios/.build/Build/Products}
source ios/scripts/ci-simulator.sh
# Finish cold Simulator boot before fixture services compete for CPU and process slots.
# The workflow starts the boot before dependency setup and passes IOS_SIMULATOR_UDID.
udid=$(ci_phase simulator-start ci_start_simulator)
ci_phase simulator-ready xcrun simctl bootstatus "$udid" -b
fixture_root=/tmp/ab-ios-parity
fixture_archive="/tmp/ab-ios-fixture-logs/$mode-$shard-$$"
mkdir "$fixture_root"
chmod 700 "$fixture_root"
pids=()
# A backgrounded ci_phase is a subshell whose command is its child, and fixtures
# can spawn their own children. Signal descendants before parents so none is orphaned.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}
cleanup() {
  local status=$? archive_status=0
  for pid in "${pids[@]}" ${photos_pid:-}; do kill_tree "$pid"; done
  local socket="$fixture_root/tmux-$(id -u)/default"
  env -u TMUX tmux -S "$socket" list-windows -a -F '#{window_id}' 2>/dev/null | sort -u | while read -r window; do
    env -u TMUX tmux -S "$socket" kill-window -t "$window" || true
  done || true
  for pid in "${pids[@]}" ${photos_pid:-}; do wait "$pid" 2>/dev/null || true; done
  mkdir -p /tmp/ab-ios-fixture-logs && mv "$fixture_root" "$fixture_archive" || archive_status=$?
  ci_diagnostics_stop
  if [ "$status" -ne 0 ]; then return "$status"; fi
  return "$archive_status"
}
trap cleanup EXIT
export TMUX_TMPDIR="$fixture_root" AGENTBOARD_DATA_DIR="$fixture_root/data" TMUX_SESSION=ab-ios-parity PORT=4151
export CLAUDE_RESUME_CMD="/bin/zsh -f -c 'exec /bin/zsh -f' {sessionId}"
unset TMUX
if needs backend; then
  ci_phase tmux-ready bun ios/scripts/tmux-ready.ts
  # The Simulator boot keeps the runner loaded. Raise only this backend's tmux
  # budget, and keep the stall watchdog from spawning `sample` into that load.
  AGENTBOARD_TMUX_TIMEOUT_MS=15000 AGENTBOARD_STALL_WATCHDOG=0 \
    bun src/server/index.ts > "$fixture_root/backend.log" 2>&1 & backend_pid=$!
  pids+=("$backend_pid")
  ci_phase backend-ready wait_backend_ready "$backend_pid" 180
  if needs live; then ci_phase seed-live bun ios/scripts/seed-live.ts; fi
  if needs parity; then ci_phase seed-parity bun ios/scripts/seed-parity.ts; fi
fi
# Photos library setup is slow on a fresh Simulator. Overlap it with fixture
# startup and app installation, then join it before tests.
photos_pid=
if needs photos; then
  ci_phase photos-import xcrun simctl addmedia "$udid" "$fixture_root/photo.png" & photos_pid=$!
fi
export NATIVE_PARITY_SHELL_RESUME=1
if needs warm; then
  ci_phase warm-parity bun ios/scripts/warm-parity.ts
  ci_phase parity-media-ready bun ios/scripts/parity-media-ready.ts
fi
for fixture in shell-server pr-fixture parity-gap-fixture media-activity-fixture; do
  if ! needs "$fixture"; then continue; fi
  bun "ios/scripts/$fixture.ts" > "$fixture_root/$fixture.log" 2>&1 & pids+=("$!")
  if [ "$fixture" = media-activity-fixture ]; then media_pid=$!; fi
done
if needs media-activity-fixture; then
  # The control endpoint starts only after the fixture wakes its session,
  # which is slow while the Simulator boot loads the runner.
  wait_media() {
    local deadline=$((SECONDS + 150))
    while [ "$SECONDS" -lt "$deadline" ]; do
      if ! kill -0 "$media_pid" 2>/dev/null; then
        echo "Media activity fixture exited before its controls started; inspect archived fixture logs." >&2
        return 1
      fi
      if curl --max-time 10 -fsS -X POST http://127.0.0.1:4193/activity/running >/dev/null; then return; fi
      sleep 1
    done
    curl --max-time 10 -fsS -X POST http://127.0.0.1:4193/activity/running >/dev/null
  }
  ci_phase media-ready wait_media
fi
# Each batch gets fresh app preferences and Documents, even on a warm Simulator.
ci_phase app-uninstall xcrun simctl uninstall "$udid" dev.agentboard.ios-spike 2>/dev/null || true
ci_phase app-install xcrun simctl install "$udid" "$IOS_TEST_PRODUCTS_DIR/Debug-iphonesimulator/AgentboardSpike.app"
# `wait` must run in this shell, which owns the import job; its status fails the batch.
if [ -n "$photos_pid" ]; then wait "$photos_pid"; fi
if needs files; then
  ci_phase files-import bash ios/scripts/seed-file.sh "$udid" "$fixture_root/upload.txt"
fi
# A fixture crash during Simulator startup must not become dozens of slow UI failures.
for pid in "${pids[@]}"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Fixture process $pid exited before tests; inspect archived fixture logs." >&2
    exit 1
  fi
done
if needs backend; then ci_phase backend-pre-tests wait_backend_ready "$backend_pid" 180; fi
ci_phase tests ./ios/scripts/test-e2e.sh "$udid" "$mode" "$shard"
if needs files; then ci_phase files-export-verify bash ios/scripts/verify-file-export.sh "$udid" "$fixture_root/export-expected.pdf"; fi
