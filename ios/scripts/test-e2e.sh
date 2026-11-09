#!/bin/bash
# Reuse compiled test products; keep tests serial within each isolated fixture host.
set -euo pipefail
cd "$(dirname "$0")/../.."
udid=${1:?Usage: ios/scripts/test-e2e.sh SIMULATOR_UDID [all|light|dark] [SHARD]}
mode=${2:-all}
shard=${3:-all}
case "$mode" in all|light|dark) ;; *) echo "Expected all, light or dark" >&2; exit 2 ;; esac
# Validate selection before building or modifying Simulator state.
bun ios/scripts/e2e-selection.ts light "$shard" >/dev/null
run_id=${IOS_E2E_RUN_ID:-$(date +%Y%m%d-%H%M%S)}
if [ -z "${IOS_TEST_PRODUCTS_DIR:-}" ]; then ./ios/scripts/build-for-testing.sh; fi
products=${IOS_TEST_PRODUCTS_DIR:-ios/.build/Build/Products}
test_runs=("$products"/*.xctestrun)
if [ "${#test_runs[@]}" -ne 1 ] || [ ! -f "${test_runs[0]}" ]; then
  echo "Expected one .xctestrun in $products" >&2; exit 2
fi
xcrun simctl bootstatus "$udid" -b
mkdir -p ios/evidence
restore() {
  xcrun simctl ui "$udid" appearance light
  xcrun simctl ui "$udid" content_size large
}
trap restore EXIT
for appearance in light dark; do
  if [ "$mode" != all ] && [ "$mode" != "$appearance" ]; then continue; fi
  xcrun simctl ui "$udid" appearance "$appearance"
  size=large
  if [ "$appearance" = dark ]; then size=accessibility-extra-extra-extra-large; fi
  xcrun simctl ui "$udid" content_size "$size"
  selection=$(bun ios/scripts/e2e-selection.ts "$appearance" "$shard")
  args=()
  while IFS= read -r test; do args+=("-only-testing:$test"); done <<< "$selection"
  xcodebuild test-without-building -parallel-testing-enabled NO -xctestrun "${test_runs[0]}" \
    -destination "id=$udid" -resultBundlePath "ios/evidence/e2e-$run_id-$appearance-$shard.xcresult" "${args[@]}"
done
