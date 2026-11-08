#!/bin/bash
# Disposable CI host only. Never reuse an existing private fixture directory.
set -euo pipefail
cd "$(dirname "$0")/../.."
fixture_root=/tmp/ab-ios-parity
mkdir "$fixture_root"
chmod 700 "$fixture_root"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  local socket="$fixture_root/tmux-$(id -u)/default"
  env -u TMUX tmux -S "$socket" list-windows -a -F '#{window_id}' 2>/dev/null | sort -u | while read -r window; do
    env -u TMUX tmux -S "$socket" kill-window -t "$window" || true
  done
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
NATIVE_PARITY_SHELL_RESUME=1 bun ios/scripts/warm-parity.ts
for fixture in shell-server pr-fixture parity-gap-fixture media-activity-fixture; do
  bun "ios/scripts/$fixture.ts" > "$fixture_root/$fixture.log" 2>&1 & pids+=("$!")
done
./ios/scripts/prepare.sh
udid=$(xcrun simctl list devices available -j | bun -e 'const data=await Bun.stdin.json(); const phone=Object.entries(data.devices).filter(([runtime])=>runtime.includes("iOS-26-4")).flatMap(([,devices])=>devices).find(d=>d.name.includes("iPhone") && d.isAvailable); if(!phone) throw Error("No available iPhone Simulator"); console.log(phone.udid)')
xcrun simctl boot "$udid" || true
xcrun simctl bootstatus "$udid" -b
xcodebuild build-for-testing -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike -destination "id=$udid" -derivedDataPath ios/.build CODE_SIGNING_ALLOWED=NO
xcrun simctl install "$udid" ios/.build/Build/Products/Debug-iphonesimulator/AgentboardSpike.app
xcrun simctl addmedia "$udid" "$fixture_root/photo.png"
app_data=$(xcrun simctl get_app_container "$udid" dev.agentboard.ios-spike data)
mkdir -p "$app_data/Documents"
cp "$fixture_root/upload.txt" "$app_data/Documents/parity-upload.txt"
./ios/scripts/test-e2e.sh "$udid"
