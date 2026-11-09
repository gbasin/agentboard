#!/bin/bash
# Produce relocatable Simulator test bundles once for every CI shard.
set -euo pipefail
cd "$(dirname "$0")/../.."
./ios/scripts/prepare.sh
xcodebuild build-for-testing -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/.build ARCHS=arm64
