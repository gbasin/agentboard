#!/bin/sh
# Run the complete native suite against the documented isolated fixtures.
set -eu
cd "$(dirname "$0")/../.."
udid=${1:?Usage: ios/scripts/test-e2e.sh SIMULATOR_UDID}
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
  -only-testing:AgentboardSpikeUITests/SessionActionUITests \
  -only-testing:AgentboardSpikeUITests/SimulatorStateUITests
