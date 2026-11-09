# Native CI

The workflow builds the app and test bundles once. It archives `Build/Products`, including the `.xctestrun` file, in a tar file to preserve executable permissions and symlinks. Five macOS workers download that artifact and run `xcodebuild test-without-building`.

Both jobs use the standard `xcode-27` runner, currently a free public preview. CI pins Xcode 27.2 at `/Applications/Xcode_27.2.app/Contents/Developer` and selects the available `iPhone 17` on the exact iOS 27.2 runtime. The [runner image manifest](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md) lists the installed toolchain and Simulators. The app's minimum deployment target remains iOS 18.

| Shard | Workflows |
|---|---|
| terminal | Native unit/integration tests, terminal input, selection, rotation and connection states |
| catalog | Glass catalog, filters, ordering, capability gates and recovery notices |
| lifecycle | Create, duplicate, rename, end, hibernate, Library transcript and pin |
| media | Media/activity, document previews, clipboard, file and photo insertion |
| settings | Settings, presets, device preferences, catalog preferences and PR checks |

Pull requests run every shard in light/standard text and dark/maximum text. Manual dispatch accepts `shard` and `appearance` choices for a targeted development run; both default to `all`. A targeted run does not replace the full PR check. Simulator boot completes before fixture services start. Each appearance starts fresh private fixture data and an app container. Shards start only the backend and fixture services that their tests consume. Each worker runs its second batch even if its first batch fails. The failed step still fails the job. Test execution stays serial inside each fixture host because workflows mutate shared sessions and settings. The wrapper checks every fixture process and backend health before starting tests. A dead fixture fails the job immediately. Catalog tests use their fixture proxy without starting the backend.

`e2e-selection.test.ts` compares shard selections with the Swift test methods. It rejects duplicate, missing and empty selections. The existing light-only tests remain light-only. External-service acceptance tests remain opt-in. The native test target runs once in the light terminal shard. It includes real-backend integration tests and requires parity seeding, lifecycle warming, and the media/activity fixture.

Five workers fit the standard [GitHub macOS concurrency limit](https://docs.github.com/en/actions/reference/limits). Other workflows may still consume runner capacity. The build reuse follows Apple's [Build For Testing and Test Without Building workflow](https://developer.apple.com/library/archive/technotes/tn2339/_index.html). Hosted elapsed time must be measured after rollout; no fixed duration is guaranteed.

## Run a shard locally

Prepare the isolated fixtures from README.md.

Run the selection check:

```sh
bun test ./ios/scripts/e2e-selection.test.ts
```

Build the test products:

```sh
./ios/scripts/build-for-testing.sh
```

Run a shard against those products:

```sh
IOS_TEST_PRODUCTS_DIR="$PWD/ios/.build/Build/Products" \
  ./ios/scripts/test-e2e.sh YOUR_UDID light settings
```

Use `all` as the final argument to select every workflow. Omit `IOS_TEST_PRODUCTS_DIR` to build once before testing. Use `ci-e2e.sh` only on a disposable fixture host; it refuses to reuse `/tmp/ab-ios-parity` and archives its owned fixture directory after cleanup.

Set `IOS_SIMULATOR_UDID` to select a different local Simulator when using `ci-e2e.sh`. An explicit UDID bypasses CI's pinned discovery. Local build and test scripts use the selected Xcode and the supplied UDID.

## Results

Each shard uploads `.xcresult` bundles, fixture logs and CI diagnostics immediately after each appearance, including failures. `/tmp/ab-ios-diagnostics/` contains per-run `phases.tsv` timings with UTC start times, elapsed seconds and exit status. `resources.log` records phase markers and samples CPU, resident memory and processes at diagnostics startup, shutdown and every 30 seconds. Phase boundaries do not run resource probes. Simulator cache preparation, boot, app installation, media import, file setup, fixture seeding and readiness waits have separate timings. `environment.txt` records the runner image, selected Xcode path and CoreSimulator version. The cleanup trap stops the sampler and fixture processes while retaining the original failure status. A first-batch failure can be inspected while the second batch continues. A failed shard keeps its results. A new push cancels an obsolete run for the same PR. Keep a failed result as a failure when reporting follow-up verification.

The first shared-build run, [42521922736](https://github.com/gbasin/agentboard/actions/runs/42521922736), took 31m48s and failed four UI tests (76/76 native, 33/34 light UI, 23/26 dark UI passed). Shared compilation took 82 seconds. The terminal shard spent 7m22s between boot completion and test invocation. That run lacked command-level setup timings, so the cause of this gap remains unproven. This failed run is not a green performance baseline.

### Setup optimization benchmark (2026-11-08)

The optimized light/settings shard passed all four UI tests on m5p using the compiled artifact from hosted run `42525063758` (artifact `13634669072`). The artifact SHA-256 was `32c2384601e55f1e15428480c28b46f3f2b0320daf4ec20fce6d1b29e92ee978`. The host used Xcode 26.4 (17E192), iOS 26.4 (23E244), and Bun 1.3.14.

A dedicated Simulator took 17 seconds to boot before the wrapper started. The wrapper took 195 seconds: nine seconds before tests and 186 seconds in the test phase. XCTest reported 171.818 seconds of test execution. Backend readiness took one second, parity warming one second, and app installation four seconds. This shard did not import Photos or Files. The dedicated Simulator and owned fixture processes were removed after validation.

These timings establish a passing warm-host result for the shared artifact. They do not establish a hosted CI speedup: the hosted settings job had not finished, its exact runtime build was unverified, and machine load differed. Run the optimized workflow on hosted CI before rebalancing shards. Two simultaneous fixture-backed Simulators still require separate ports, paths, and mutable session state.

### Full hosted validation

Run [42527001881](https://github.com/gbasin/agentboard/actions/runs/42527001881) failed after 43m02s. It does not establish a speedup. Light setup took 238–353 seconds per shard; completed dark setup took 11–52 seconds. Settings test execution took 535 seconds in light and 419 seconds in dark. The hosted runtime was iOS 26.4.1 (23E254a), unlike the m5p runtime above.

The run exposed omitted parity dependencies in the native test target and a media preview test that needed to follow the catalog's explicit refresh action. Lifecycle dark hit its job timeout during repeated native-menu gestures and animation-idle waits. Its transcript test passed. Retain these failures when comparing a corrected run; do not treat a faster failed run as successful full-suite validation.

### Balanced warm workers

The workflow keeps five workers and assigns whole shard/appearance batches as follows:

| Worker | First batch | Second batch |
|---|---|---|
| 1 | terminal light | terminal dark |
| 2 | media light | catalog dark |
| 3 | catalog light | lifecycle dark |
| 4 | lifecycle light | media dark |
| 5 | settings light | settings dark |

`ci-workers.ts` filters these assignments for manual runs and drops empty workers. Each selected batch runs once. Whole-batch assignments preserve the existing test selections and fixture plans. Each invocation of `ci-e2e.sh` removes the app container, creates fresh fixture data, checks readiness, archives fixture logs, and records phase/resource diagnostics. The simulator remains booted between batches. Results upload after each batch. No test executes concurrently against the same fixture host.
