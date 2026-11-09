#!/bin/bash
# Archive a Release build for internal TestFlight using the signed-in Xcode team.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -ne 2 ]; then
  echo "Usage: archive-testflight.sh TEAM_ID BUILD_NUMBER" >&2
  exit 2
fi
team_id="$1"
build_number="$2"
if ! [[ "$build_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUILD_NUMBER must be a positive integer." >&2
  exit 2
fi
if [ ! -d AgentboardSpike.xcodeproj ]; then
  echo "Run ios/scripts/prepare.sh first." >&2
  exit 1
fi
output_dir=".build-testflight/$build_number"
if [ -e "$output_dir" ]; then
  echo "Build output already exists: $output_dir. Use a new build number." >&2
  exit 1
fi
mkdir -p "$output_dir"
if ! xcodebuild -quiet -project AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$output_dir/Agentboard.xcarchive" \
  -derivedDataPath .build-testflight/DerivedData \
  -allowProvisioningUpdates "DEVELOPMENT_TEAM=$team_id" \
  CODE_SIGN_STYLE=Automatic 'CODE_SIGN_IDENTITY=Apple Development' \
  "CURRENT_PROJECT_VERSION=$build_number" INJECTION_RESOURCES= archive \
  > "$output_dir/archive.log" 2>&1; then
  tail -60 "$output_dir/archive.log" >&2
  exit 1
fi
echo "Archive ready: $PWD/$output_dir/Agentboard.xcarchive"
