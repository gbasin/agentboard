# Native CI

The workflow builds the app and test bundles once. It archives `Build/Products`, including the `.xctestrun` file, in a tar file to preserve executable permissions and symlinks. Five macOS workers download that artifact and run `xcodebuild test-without-building`.

Both jobs use the standard `xcode-27` runner, [generally available](https://github.blog/changelog/2026-10-15-xcode-27-runner-image-generally-available/). CI pins Xcode 27.2 at `/Applications/Xcode_27.2.app/Contents/Developer` and selects the available `iPhone 17` on the exact iOS 27.2 runtime. The [runner image manifest](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md) lists the installed toolchain and Simulators. The app's minimum deployment target remains iOS 18.

| Shard | Workflows |
|---|---|
| terminal | Native unit/integration tests, compact terminal input, keyboard, rotation and connection states |
| live | Real-shell paste, scrollback, flick momentum, selection and background recovery |
| catalog | Glass catalog, filters, ordering, capability gates and recovery notices |
| lifecycle | Create, duplicate, rename, end, hibernate, Library transcript and pin |
| media | Media/activity, document previews, clipboard, file and photo insertion |
| settings | Settings, presets, device preferences, catalog preferences and PR checks |

Each simulator job turns off host Spotlight indexing and starts the Simulator boot before tmux, Bun and artifact setup. The boot prepares only the pinned iOS 27.2 runtime's dyld shared cache. `ci-e2e.sh` waits for `bootstatus` before it starts fixture services. The Photos import runs in the background during fixture startup and app installation, and the batch waits for it before tests.

A cold Simulator boot keeps the hosted runner loaded, so the CI backend runs with `AGENTBOARD_TMUX_TIMEOUT_MS=15000` and `AGENTBOARD_STALL_WATCHDOG=0`. These settings apply only to the fixture backend. Readiness waits allow 180 seconds before fixtures and again before tests.

`test-e2e.sh` runs a trimmed copy of the `.xctestrun`. The copy captures screenshots instead of screen recordings and disables the performance anti-pattern checker. `xcodebuild` collects no failure diagnostics and retries each failed test once. The result bundle keeps the first failure, so a retried test stays visible.

Pull requests run every shard in light/standard text and dark/maximum text. Manual dispatch accepts `shard` and `appearance` choices for a targeted development run; both default to `all`. A targeted run does not replace the full PR check. Simulator boot completes before fixture services start. Each appearance starts fresh private fixture data and an app container. Shards start only the backend and fixture services that their tests consume. Each worker runs its later batches even if an earlier batch fails. The failed step still fails the job. Test execution stays serial inside each fixture host because workflows mutate shared sessions and settings. The wrapper checks every fixture process and backend health before starting tests. A dead fixture fails the job immediately. Catalog tests use their fixture proxy without starting the backend.

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

Set `IOS_SIMULATOR_UDID` to select a different local Simulator when using `ci-e2e.sh`. An explicit UDID bypasses CI's pinned discovery and the pinned runtime's dyld cache preparation. Local build and test scripts use the selected Xcode and the supplied UDID.

## Results

Each shard uploads `.xcresult` bundles, fixture logs and CI diagnostics immediately after each appearance, including failures. `/tmp/ab-ios-diagnostics/` contains per-run `phases.tsv` timings with UTC start times, elapsed seconds and exit status. `resources.log` records phase markers and samples load, process count, the top processes by CPU and by resident memory, and free disk space at diagnostics startup, shutdown and every 30 seconds. Phase boundaries do not run resource probes. Simulator start, boot completion, app installation, media import, file setup, fixture seeding and readiness waits have separate timings. `environment.txt` records the runner image, CPU count, memory size, selected Xcode path and CoreSimulator version. The cleanup trap stops the sampler and fixture processes while retaining the original failure status. A first-batch failure can be inspected while the second batch continues. A failed shard keeps its results. A new push cancels an obsolete run for the same PR. Keep a failed result as a failure when reporting follow-up verification.

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

| Worker | First batch | Second batch | Third batch |
|---|---|---|---|
| 1 | terminal light | catalog dark | |
| 2 | live light | live dark | settings dark |
| 3 | media light | terminal dark | |
| 4 | lifecycle light | media dark | |
| 5 | catalog light | lifecycle dark | settings light |

The assignment balances median XCTest seconds per batch. The simulator job timeout leaves room for a few retried UI tests above the balanced duration.

`ci-workers.ts` filters these assignments for manual runs and drops empty workers. Each selected batch runs once. Whole-batch assignments preserve the existing test selections and fixture plans. Each invocation of `ci-e2e.sh` removes the app container, creates fresh fixture data, checks readiness, archives fixture logs, and records phase/resource diagnostics. The simulator remains booted between batches. Results upload after each batch. No test executes concurrently against the same fixture host.

### Cold Simulator startup readiness

Run 42662550144 failed before terminal/media tests: `tmux -V` exceeded the
production three-second startup limit while the hosted Simulator load average
rose above 490. Do not treat these fixture failures as app test results.

After Simulator boot, backend-dependent batches probe `tmux -V` until three
consecutive probes finish within three seconds, with a total two-minute budget.
The probe does not connect to a tmux server. It never retries mutations or tests.
Production tmux timeouts remain unchanged. If the host cannot become responsive,
the batch fails with resource diagnostics instead of launching the backend.
Both initial and pre-test HTTP readiness checks stop if the backend exits.
A passing readiness gate reduces the observed cold-start race; hosted validation
is still required and it does not guarantee later host responsiveness.
