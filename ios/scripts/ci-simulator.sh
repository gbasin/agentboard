#!/bin/bash
# Source from CI orchestration, or run directly to start a boot early and print its UDID.
# Prepares only the pinned iOS runtime: `--all` also walks every
# tvOS, watchOS and visionOS runtime on the image.
ci_start_simulator() {
  local runtime udid=${IOS_SIMULATOR_UDID:-}
  # An explicit UDID may name a Simulator on any runtime: skip the pinned
  # runtime's preparation and discovery. The workflow's early step prepares
  # the pinned runtime once, then exports the UDID for later batches.
  # Explicit returns keep failures fatal inside command substitution, where
  # Bash ignores errexit.
  if [ -z "$udid" ]; then
    runtime=$(bun ios/scripts/ci-simulator.ts runtime) || return
    xcrun simctl runtime dyld_shared_cache update "$runtime" >&2 || return
    udid=$(xcrun simctl list devices available -j | bun ios/scripts/ci-simulator.ts) || return
  fi
  # 149 means already booted, which an early-start workflow step makes the normal case.
  xcrun simctl boot "$udid" >&2 || true
  printf '%s\n' "$udid"
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  cd "$(dirname "$0")/../.."
  ci_start_simulator
fi
