# Native CI

The workflow builds the app and test bundles once. It archives `Build/Products`, including the `.xctestrun` file, in a tar file to preserve executable permissions and symlinks. Five macOS workers download that artifact and run `xcodebuild test-without-building`.

| Shard | Workflows |
|---|---|
| terminal | Native unit tests, terminal input, selection, rotation and connection states |
| catalog | Glass catalog, filters, ordering, capability gates and recovery notices |
| lifecycle | Create, duplicate, rename, end, hibernate, Library transcript and pin |
| media | Media/activity, document previews, clipboard, file and photo insertion |
| settings | Settings, presets, device preferences, catalog preferences and PR checks |

Each worker runs light/standard text and dark/maximum text. Simulator boot completes before fixture services start. Each appearance starts a fresh private backend, app container and fixture data. Dark runs even if the light test step fails. Test execution stays serial inside each fixture host because workflows mutate shared sessions and settings. The wrapper checks every fixture process and backend health before starting tests. A dead fixture fails the job immediately.

`e2e-selection.test.ts` compares shard selections with the Swift test methods. It rejects duplicate, missing and empty selections. The existing light-only tests remain light-only. External-service acceptance tests remain opt-in. Unit tests run once in the light terminal shard.

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

## Results

Each shard uploads `.xcresult` bundles and fixture logs immediately after each appearance. A light failure can be inspected while dark tests continue. A failed shard keeps its results. A new push cancels an obsolete run for the same PR. Keep a failed result as a failure when reporting follow-up verification.
