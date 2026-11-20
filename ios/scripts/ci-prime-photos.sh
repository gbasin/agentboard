#!/bin/bash
# CI only. The first Photos import on a fresh Simulator waits for the Photos
# library to start, and later simctl calls such as app uninstall queue behind
# it. When a worker runs a batch that imports a photo, start one import in the
# background during dependency setup; the batch's own import then finishes fast.
set -euo pipefail
cd "$(dirname "$0")/../.."
udid=${1:?Usage: ios/scripts/ci-prime-photos.sh SIMULATOR_UDID MODE:SHARD...}
shift
needed=
for batch in "$@"; do
  mode=${batch%%:*} shard=${batch#*:}
  if [ -z "$mode" ] || [ -z "$shard" ]; then continue; fi
  if bun ios/scripts/e2e-fixtures.ts "$mode" "$shard" | grep -qx photos; then needed=1; fi
done
if [ -z "$needed" ]; then exit 0; fi
dir=$(mktemp -d "${TMPDIR:-/tmp}/ab-ios-photo-primer.XXXXXX")
bun ios/scripts/photo-fixture.ts "$dir/primer.png"
nohup bash -c 'xcrun simctl bootstatus "$1" -b >/dev/null && xcrun simctl addmedia "$1" "$2"' _ "$udid" "$dir/primer.png" > "$dir/import.log" 2>&1 &
echo "Photos import started in the background; log: $dir/import.log"
