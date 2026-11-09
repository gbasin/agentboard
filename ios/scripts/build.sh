#!/bin/bash
# CLI build log adapter for InjectionNext's Xcode activity-log scanner.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${1:?Usage: build.sh SIMULATOR_UDID}"
mkdir -p .build/Logs/Build
# Capture a compiler command for every view, including unchanged files.
touch AgentboardSpike/*.swift
xcodebuild -project AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination "platform=iOS Simulator,id=$1" -derivedDataPath .build \
  "INJECTION_RESOURCES=${INJECTION_RESOURCES:-}" build 2>&1 | tee .build/cli-build.log
# This is a gzip of real CLI compiler output, not an Xcode result bundle.
# InjectionNext scans decompressed command lines; CLI builds do not always
# produce those lines in their normal xcactivitylog files.
gzip -c .build/cli-build.log > .build/Logs/Build/spike-commands.xcactivitylog
