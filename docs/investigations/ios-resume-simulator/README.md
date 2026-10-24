# Native iOS Simulator recovery checks

On 2026-10-24, native XCTest drove Safari and an installed Agentboard Home Screen app on the remote M5P MacBook. The dedicated simulator was an iPhone 17 Pro with iOS 26.4 (23E244).

The checks passed. The server-side capture in [pane-markers.json](pane-markers.json) confirmed all 11 markers appeared exactly once in the intended pane. [The final screenshot](integrated-final-connected.png) shows the connected Home Screen app after termination, relaunch, and another background/resume cycle.

## Prerequisites

- Run on the remote Mac with Xcode and an installed iOS runtime. Do not boot a local simulator.
- Use a dedicated simulator. Do not select an existing user device.
- Use an isolated Agentboard server with its own data directory and tmux socket.
- Create exactly two fixture windows: `resume-ios-a` and `resume-ios-b`. Each must run `stty -echo; exec /bin/cat`.
- Expose the fixture server to the remote simulator at `http://127.0.0.1:5190`. This run used an SSH reverse forward to the root machine's isolated port 4190.
- Keep the two mobile tabs numbered 1 and 2. Use an empty Home Screen installation state for Agentboard.

Example server isolation from the repository root:

```sh
fixture_dir=$(mktemp -d /tmp/ab-ios.XXXXXX)
env -u TMUX TMUX_TMPDIR="$fixture_dir" AGENTBOARD_DATA_DIR="$fixture_dir/data" PORT=4190 TMUX_SESSION=resume-ios bun run dev
```

Create the two fixture windows on that same private socket. Always pass `env -u TMUX TMUX_TMPDIR="$fixture_dir"` to fixture tmux commands. Do not use the production socket. Capture the pane IDs before testing.

From the server machine, create the tunnel:

```sh
ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:5190:127.0.0.1:4190 garybasin@macbook-m5p
```

## Run

Copy this directory to a new remote temporary directory. Run these commands on the remote Mac:

```sh
xcrun simctl list runtimes
sim_id=$(xcrun simctl create Agentboard-Resume-Test com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4)
xcrun simctl boot "$sim_id"
xcrun simctl bootstatus "$sim_id" -b
xcodebuild test -project ResumeUITests.xcodeproj -scheme ResumeUITests -destination "id=$sim_id" -derivedDataPath build -resultBundlePath safari-short.xcresult ONLY_ACTIVE_ARCH=YES
```

Run the remaining scenarios in this order. Before each run, copy the selected source over `ResumeUITests.swift`, uninstall the test runner, and use a new result path:

1. `SafariLongUITests.swift`: switch to B, background Safari for 45 seconds, resume, then switch to A.
2. `HomeUITests.swift`: install through Safari's Share menu, launch the Home Screen app, background for 45 seconds, resume, then switch to B.
3. `FinalUITests.swift`: relaunch Safari, terminate and relaunch the Home Screen app, verify its retained B selection through marker routing, then background for 4 seconds and resume.

```sh
cp SafariLongUITests.swift ResumeUITests.swift
xcrun simctl uninstall "$sim_id" com.agentboard.test.ResumeUITests.xctrunner
xcodebuild test -project ResumeUITests.xcodeproj -scheme ResumeUITests -destination "id=$sim_id" -derivedDataPath build -resultBundlePath safari-long.xcresult ONLY_ACTIVE_ARCH=YES
```

Uninstalling the runner avoids an observed stale test binary during iterative runs. Check the test method name in each log.

## Validate and clean up

XCTest success alone does not assert terminal delivery. Capture both fixture panes independently:

```sh
env -u TMUX TMUX_TMPDIR="$fixture_dir" tmux capture-pane -p -S - -t 'resume-ios:@0'
env -u TMUX TMUX_TMPDIR="$fixture_dir" tmux capture-pane -p -S - -t 'resume-ios:@1'
```

Assert every marker appears exactly once and only in its intended A or B pane. Compare against `pane-markers.json`. Take a screenshot after the last marker is visible and the header is connected. Archive the raw logs and xcresult bundles outside git.

Stop only the fixture server and tunnel you started. Remove only the named fixture sessions. Shut down and delete only the simulator you created:

```sh
xcrun simctl shutdown "$sim_id"
xcrun simctl delete "$sim_id"
```

## Limits

These checks exercise actual Simulator app transitions. A separate diagnostic page confirmed native visibility changes and retained JavaScript state in both Safari and Home Screen mode. SafariDriver automation was not used for the final checks because its lifecycle behavior differed from ordinary native app switching.

The harness includes fixed two-second settle waits. It checks recovery correctness, not resume latency. It does not reproduce physical-device memory pressure, radio suspension, thermal limits, or Tailscale reconnection.

The remote host could reach the Tailscale HTTP origin, but this simulator's Safari showed about:blank for that origin. The successful checks used the SSH loopback forward instead. Loopback changes the network path and browser-origin security classification; direct Tailscale HTTP behavior still needs physical-device validation.

The checked-in sources normalize the exploratory harness for reuse. The final source variant and all four native scenarios were executed; the cleaned-up first scenario was not rerun after documentation formatting.
