#!/bin/bash
# Disposable CI host only. Never reuse an existing private fixture directory.
set -euo pipefail
cd "$(dirname "$0")/../.."
mode=${IOS_E2E_MODE:-all}
shard=${IOS_E2E_SHARD:-all}
case "$mode" in all|light|dark) ;; *) echo "Invalid IOS_E2E_MODE" >&2; exit 2 ;; esac
bun ios/scripts/e2e-selection.ts light "$shard" >/dev/null
fixture_root=/tmp/ab-ios-parity
fixture_archive="/tmp/ab-ios-fixture-logs/$mode-$shard-$$"
mkdir "$fixture_root"
chmod 700 "$fixture_root"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  local socket="$fixture_root/tmux-$(id -u)/default"
  env -u TMUX tmux -S "$socket" list-windows -a -F '#{window_id}' 2>/dev/null | sort -u | while read -r window; do
    env -u TMUX tmux -S "$socket" kill-window -t "$window" || true
  done || true
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  mkdir -p /tmp/ab-ios-fixture-logs
  mv "$fixture_root" "$fixture_archive"
  return 0
}
trap cleanup EXIT
export TMUX_TMPDIR="$fixture_root" AGENTBOARD_DATA_DIR="$fixture_root/data" TMUX_SESSION=ab-ios-parity PORT=4151
export CLAUDE_RESUME_CMD="/bin/zsh -f -c 'exec /bin/zsh -f' {sessionId}"
unset TMUX
bun src/server/index.ts > "$fixture_root/backend.log" 2>&1 & pids+=("$!")
for attempt in {1..60}; do
  if curl -fsS http://127.0.0.1:4151/api/library/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:4151/api/library/health >/dev/null
bun ios/scripts/seed-live.ts
bun ios/scripts/seed-parity.ts
export NATIVE_PARITY_SHELL_RESUME=1
bun ios/scripts/warm-parity.ts
for fixture in shell-server pr-fixture parity-gap-fixture media-activity-fixture; do
  bun "ios/scripts/$fixture.ts" > "$fixture_root/$fixture.log" 2>&1 & pids+=("$!")
done
# The control endpoint starts only after the fixture session has been created.
for attempt in {1..60}; do
  if curl -fsS -X POST http://127.0.0.1:4193/activity/running >/dev/null; then break; fi
  sleep 1
done
curl -fsS -X POST http://127.0.0.1:4193/activity/running >/dev/null
if [ -z "${IOS_TEST_PRODUCTS_DIR:-}" ]; then ./ios/scripts/build-for-testing.sh; fi
export IOS_TEST_PRODUCTS_DIR=${IOS_TEST_PRODUCTS_DIR:-ios/.build/Build/Products}
udid=$(xcrun simctl list devices available -j | bun -e 'const data=await Bun.stdin.json(); const phone=Object.entries(data.devices).filter(([runtime])=>runtime.includes("iOS-26-4")).flatMap(([,devices])=>devices).find(d=>d.name.includes("iPhone") && d.isAvailable); if(!phone) throw Error("No available iPhone Simulator"); console.log(phone.udid)')
udid=${IOS_SIMULATOR_UDID:-$udid}
xcrun simctl boot "$udid" || true
xcrun simctl bootstatus "$udid" -b
# Each appearance gets fresh app preferences and Documents as well as fresh backend data.
xcrun simctl uninstall "$udid" dev.agentboard.ios-spike 2>/dev/null || true
xcrun simctl install "$udid" "$IOS_TEST_PRODUCTS_DIR/Debug-iphonesimulator/AgentboardSpike.app"
xcrun simctl addmedia "$udid" "$fixture_root/photo.png"
app_data=$(xcrun simctl get_app_container "$udid" dev.agentboard.ios-spike data)
mkdir -p "$app_data/Documents"
cp "$fixture_root/upload.txt" "$app_data/Documents/parity-upload.txt"
./ios/scripts/test-e2e.sh "$udid" "$mode" "$shard"
