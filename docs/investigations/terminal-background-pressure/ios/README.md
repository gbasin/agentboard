# Native iOS recovery-draft validation

## Persistent draft follow-up

The follow-up native run validated durable drafts on a fresh Safari origin, `http://127.0.0.1:5193`, forwarded to the same isolated fixture server on port 4192. It used a new dedicated remote simulator.

`PersistentDraftUITests.swift` passed these steps:

1. Connect to A and focus the terminal.
2. Stop the fixture server at `IOS_PERSIST_READY_STOP_SERVER`.
3. Type `IOS_PERSIST_REVIEW\n`. Assert the exact draft and disabled Send text.
4. Restart at `IOS_PERSIST_CAPTURED_RESTART_SERVER`. Assert the draft remains and Send becomes enabled.
5. Tap Safari's native Reload control. Assert the exact draft survives the document reload and Send is enabled.
6. Pause 15 seconds at `IOS_PERSIST_RELOADED_CHECK_NO_SEND` for an independent pane capture.
7. Tap Discard text. Reload again. Assert no draft or Send control remains.

The test never taps Send. Root independently captured the pane with no marker before the reload and again after discard/reload. The harness backgrounds and activates Safari before each reload to expose browser chrome; it does not inject JavaScript.

Evidence: [offline](persist-fixed-offline.png), [draft after reload](persist-fixed-reloaded.png), [discarded after reload](persist-fixed-discarded.png). Copy `PersistentDraftUITests.swift` over the project source before using the execution command below. Set up the reverse tunnel on 5193 for this variant.

The initial persistence attempt uncovered an actual identity bug. The server's fallback `createdAt` changed on restart from `20:26:42.286Z` to `20:31:54.883Z`, although the tmux server PID and window ID stayed the same. The draft disappeared from the UI before any reload, discard, or send. Read-only inspection of the dedicated simulator's localStorage database confirmed the text still existed under the old identity. The native test failed while waiting for Send to return.

The identity fix uses the known tmux server PID and window ID without the unstable timestamp. The passing rerun used a new origin to isolate it from the earlier prototype's saved key. Raw failed and passing logs/xcresult bundles are retained outside git at `/tmp/agentboard-persist-ios-evidence/`. The dedicated simulator and remote temporary project were removed after evidence collection.

Tested on 2026-10-24 on the remote M5P MacBook. A dedicated iPhone 17 Pro simulator ran iOS 26.4 (23E244). No local simulator was used.

## Results

- With the keyboard already open, typing `IOS_DRAFT_REVIEW\n` while disconnected created an editable draft. Send text was disabled.
- After reconnection, the exact draft remained. An independent tmux capture confirmed no marker had reached the pane.
- A native tap on Send text delivered the marker. The draft disappeared. A five-second Home/background cycle did not resend it.
- Starting with the keyboard closed, the fully visible Show keyboard control opened the native keyboard while disconnected. The same checks passed for `IOS_REOPEN_REVIEW\n`.

Root independently captured the fixture pane before each send and after each resume. The first marker appeared exactly once after resume. See the parent investigation for the final capture of both markers.

Screenshots show the [offline draft](draft-offline.png), [reconnected unsent draft](draft-ready-unsent.png), and [sent marker after resume](draft-sent-resumed.png). The reopened-keyboard sequence has corresponding `reopen-*.png` images.

## Reproduce

Use an isolated Agentboard server on port 4192, with a private tmux socket and data directory. The fixtures used here were `pressure-a` and `pressure-b`, running `stty -echo; exec /bin/cat`. Select A. Never stop a production server or use the production tmux socket.

Create an SSH reverse forward from remote `127.0.0.1:5192` to the fixture server's `127.0.0.1:4192`. Copy this directory to a new remote temporary directory.

On the remote Mac:

```sh
sim_id=$(xcrun simctl create Agentboard-Draft-Test com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4)
xcrun simctl boot "$sim_id"
xcrun simctl bootstatus "$sim_id" -b
xcodebuild test -project ResumeUITests.xcodeproj -scheme ResumeUITests -destination "id=$sim_id" -derivedDataPath build -resultBundlePath draft-native.xcresult ONLY_ACTIVE_ARCH=YES > draft-native.log 2>&1
```

Monitor the log from another shell. Stop the fixture server at `IOS_STAGE_READY_FOR_SERVER_STOP`. Restart it at `IOS_STAGE_DRAFT_CAPTURED_RESTART_SERVER`. Capture the private fixture pane during the 20-second pause after `IOS_STAGE_RECONNECTED_CHECK_PANE_BEFORE_SEND`. Assert the new marker is absent. The test then taps Send text, backgrounds Safari for five seconds, and resumes. Capture the pane again. Assert the marker occurs exactly once and never in B.

Before a different scenario, copy its Swift file over `ResumeUITests.swift`. Uninstall `com.agentboard.test.ResumeUITests.xctrunner` from your simulator to avoid stale test code. Use a new result bundle path.

## Closed-keyboard harness correction

`ClosedKeyboardUITests.swift` records the initial failed attempt. The keyboard control was partially clipped at x390 with width44 in a 402-point viewport. XCTest reported it hittable, but its native tap did not open the keyboard. The keyboard assertion failed; subsequent typing had no focused input.

With that offline page retained, `KeyboardProbe.swift` explicitly dragged the horizontal toolbar. The keyboard control moved to x352 and became fully visible. Its native tap opened the keyboard and the native keyboard assertion passed.

`ReopenedDraftUITests.swift` then continued on that same page and validated the second draft, reconnect, explicit send, and resume sequence. This split preserves the actual successful execution rather than claiming the original closed-keyboard scenario passed unchanged. A future combined harness should always scroll this control fully into view before tapping.

## Scope and cleanup

These are native XCTest actions and accessibility assertions, not synthetic JavaScript events. Fixed settling delays mean these checks do not measure latency. Simulator Safari used the SSH loopback origin; physical-device suspension, memory pressure, and direct Tailscale HTTP behavior remain separate tests. This draft pass tested Safari, not a newly installed Home Screen app.

Raw logs and xcresult bundles are archived outside tracked documentation in `/tmp/agentboard-pressure-raw-probes.tar.gz` (original `.poc-stress-test/ios/` layout). Stop only the fixture server and tunnel you created. Shut down and delete only your dedicated simulator:

```sh
xcrun simctl shutdown "$sim_id"
xcrun simctl delete "$sim_id"
```
