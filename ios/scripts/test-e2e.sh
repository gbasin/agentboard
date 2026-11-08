#!/bin/sh
# Run the complete native suite against the documented isolated fixtures.
set -eu
cd "$(dirname "$0")/../.."
udid=${1:?Usage: ios/scripts/test-e2e.sh SIMULATOR_UDID}
mode=${2:-all}
case "$mode" in all|light|dark) ;; *) echo "Expected all, light or dark" >&2; exit 2 ;; esac
run_id=${IOS_E2E_RUN_ID:-$(date +%Y%m%d-%H%M%S)}
./ios/scripts/prepare.sh
xcrun simctl bootstatus "$udid" -b
mkdir -p ios/evidence
restore() {
  xcrun simctl ui "$udid" appearance light
  xcrun simctl ui "$udid" content_size large
}
trap restore EXIT
restore
if [ "$mode" != dark ]; then
xcodebuild test -parallel-testing-enabled NO -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination "id=$udid" -derivedDataPath ios/.build \
  -resultBundlePath "ios/evidence/e2e-$run_id-light.xcresult" \
  -only-testing:AgentboardSpikeTests \
  -only-testing:AgentboardSpikeUITests/MediaActivityUITests \
  -only-testing:AgentboardSpikeUITests/NativeGlassUITests \
  -only-testing:AgentboardSpikeUITests/NativeParityUITests \
  -only-testing:AgentboardSpikeUITests/ParityGapUITests \
  -only-testing:AgentboardSpikeUITests/NativeClipboardUITests \
  -only-testing:AgentboardSpikeUITests/LiveUITests \
  -only-testing:AgentboardSpikeUITests/SessionActionUITests \
  -only-testing:AgentboardSpikeUITests/SimulatorStateUITests \
  -only-testing:AgentboardSpikeUITests/SpikeUITests
fi
if [ "$mode" != light ]; then
xcrun simctl ui "$udid" appearance dark
xcrun simctl ui "$udid" content_size accessibility-extra-extra-extra-large
xcodebuild test -parallel-testing-enabled NO -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination "id=$udid" -derivedDataPath ios/.build \
  -resultBundlePath "ios/evidence/e2e-$run_id-dark-large.xcresult" \
  -only-testing:AgentboardSpikeUITests/MediaActivityUITests \
  -only-testing:AgentboardSpikeUITests/NativeGlassUITests \
  -only-testing:AgentboardSpikeUITests/NativeParityUITests \
  -only-testing:AgentboardSpikeUITests/ParityGapUITests \
  -only-testing:AgentboardSpikeUITests/NativeClipboardUITests \
  -only-testing:AgentboardSpikeUITests/LiveUITests/testFrozenSnapshotRefreshCopyAndReturnToInput \
  -only-testing:AgentboardSpikeUITests/LiveUITests/testSessionOverviewSwitchesWithStatus \
  -only-testing:AgentboardSpikeUITests/SessionActionUITests \
  -only-testing:AgentboardSpikeUITests/SimulatorStateUITests
fi
