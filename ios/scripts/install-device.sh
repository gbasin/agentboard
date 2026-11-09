#!/bin/bash
# Build, sign, install and launch on a paired iPhone using the signed-in Xcode account.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -lt 2 ]; then
  echo "Usage: install-device.sh TEAM_ID DEVICE_UDID [SERVER_URL]" >&2
  exit 2
fi
team_id="$1"
device_udid="$2"
if [ ! -d AgentboardSpike.xcodeproj ]; then
  echo "Run ios/scripts/prepare.sh first, or sync its generated Xcode project here." >&2
  exit 1
fi
mkdir -p .build-device
if ! xcodebuild -quiet -project AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -configuration Debug -destination "platform=iOS,id=$device_udid" \
  -derivedDataPath .build-device -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  "DEVELOPMENT_TEAM=$team_id" CODE_SIGN_STYLE=Automatic 'CODE_SIGN_IDENTITY=Apple Development' \
  INJECTION_RESOURCES= build > .build-device/cli-build.log 2>&1; then
  tail -60 .build-device/cli-build.log >&2
  exit 1
fi
xcrun devicectl device install app --device "$device_udid" \
  .build-device/Build/Products/Debug-iphoneos/AgentboardSpike.app
if [ -n "${3:-}" ]; then
  xcrun devicectl device process launch --device "$device_udid" --terminate-existing \
    -- dev.agentboard.ios-spike -serverURL "$3"
else
  xcrun devicectl device process launch --device "$device_udid" --terminate-existing \
    -- dev.agentboard.ios-spike
fi
