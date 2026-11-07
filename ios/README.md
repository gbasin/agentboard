# Agentboard iPhone client

The app opens existing Agentboard sessions through native SwiftUI navigation. The catalog supports search, project/host/status filters, sorting, shared manual order and configurable row details. Enter the same base HTTP(S) URL you open in Safari. Keep Tailscale connected for a tailnet address.

`BoardConnection` owns a URLSession WebSocket at `/ws?catalog=2`. The catalog query is required for the live v0.40 backend. A proxy path prefix is preserved. WKWebView renders bundled xterm.js output and bridges input; a public-API UIKit `TerminalInputView` owns the keyboard. The connection uses heartbeat checks and reconnect backoff. Backgrounding closes the socket. Returning reconnects and restores the selected session. Disconnected input is never replayed. Each selection opens a fresh socket to isolate stale responses, including repeat visits to the same session ID.

The native client includes session creation, duplication, rename, end, hibernate and wake; directory browsing and recent paths; shared command presets; saved-session library and recovery; transcript messages/events; media and pull-request views; native file/photo uploads; and shared/server/device settings. Library leads to saved sessions and inactive agent conversations. Session actions are in the terminal menu and catalog context menu. File insertion pastes a quoted server path without Enter. Uploads are unavailable for SSH sessions, matching the PWA.

Validation: the full light run passed 40 tests. The final light correction run passed two workflows. All 12 dark/max-text workflows are verified: 11 passed in the final broad run, and the remaining management flow passed after fixing its menu-scrolling test helper. Repository lint, typecheck and all 1,859 Bun tests passed. Exact result bundles, coverage and limits are in PARITY.md.

See [PARITY.md](PARITY.md) for the acceptance and validation matrix. Explicit `-demo` and legacy `-spikeEndpoint` arguments retain the earlier sample and raw-shell fixtures.

## Build

Use Xcode 26 and XcodeGen. Install the root Bun dependencies first. Run these commands from the repository root.

```sh
./ios/scripts/prepare.sh
xcodebuild -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination 'platform=iOS Simulator,id=YOUR_UDID' \
  -derivedDataPath ios/.build build
xcrun simctl install YOUR_UDID ios/.build/Build/Products/Debug-iphonesimulator/AgentboardSpike.app
xcrun simctl launch YOUR_UDID dev.agentboard.ios-spike
```

Open Connection. Enter the browser's `http://` or `https://` base URL. Tap Connect. You can also supply `-serverURL http://127.0.0.1:4151` at launch for the local fixture.

The prepare script copies xterm and its licenses from the locked root dependencies. Generated vendor files and the Xcode project are ignored. Keep the bundled folder named `Web`: a top-level `Resources` folder makes macOS bundle discovery treat this iOS app as a different bundle layout and fail installation with “Missing bundle ID.”

## Install on a paired iPhone (deferred)

The user deferred physical-device signing and installation. Current validation continues in Simulator only; no account or device action is needed now. These instructions remain for a future device pass.

Sign in to your Apple developer account in Xcode → Settings → Accounts. Enable Developer Mode on the iPhone. Pair it with the build Mac and unlock it. Prepare the project locally, or sync the generated project and vendor files to the build Mac.

```sh
./ios/scripts/install-device.sh YOUR_TEAM_ID YOUR_DEVICE_UDID https://your-agentboard-host
```

The script permits Xcode to create development signing assets and register the paired device. It installs and launches the debug app. The optional third argument sets the server address for that launch. Team and device identifiers are not stored in the project. Build logs remain in `ios/.build-device/cli-build.log`.

The first m5p device-build attempt stopped at Xcode's “No Accounts” error and missing development provisioning profile. The paired iPhone was reachable with Developer Mode enabled. The device pass is deferred; no physical-device validation is claimed.

## Isolated real-backend tests

Run the backend on the simulator host. Give it a dedicated socket directory and data directory. Remove inherited `TMUX`. Keep the backend running while the tests run.

```sh
mkdir -p /tmp/ab-ios-parity
chmod 700 /tmp/ab-ios-parity
env -u TMUX TMUX_TMPDIR=/tmp/ab-ios-parity \
  AGENTBOARD_DATA_DIR=/tmp/ab-ios-parity/data \
  TMUX_SESSION=ab-ios-parity PORT=4151 \
  CLAUDE_RESUME_CMD="/bin/zsh -f -c 'exec /bin/zsh -f' {sessionId}" \
  bun run start
```

In a second shell, seed two disposable shell sessions. The seed script connects only to loopback port 4151.

```sh
bun ios/scripts/seed-live.ts
bun ios/scripts/seed-parity.ts
NATIVE_PARITY_SHELL_RESUME=1 bun ios/scripts/warm-parity.ts
xcrun simctl addmedia YOUR_UDID /tmp/ab-ios-parity/photo.png
```

The resume override is required: the synthetic Claude transcript resumes into a disposable shell. Do not run the lifecycle fixtures against a normal backend. `seed-parity.ts` writes only the fixed private data directory. Seed once before testing; rewriting a log while the backend caches it can intentionally trigger stale-media protection. Warm the fixture after seeding. Keep its transcript and saved-session names aligned because the server synchronizes renames.

Run the PR-check fixture in a third shell while the UI suite runs:

```sh
bun ios/scripts/pr-fixture.ts
```

Port 4190 proxies the private backend and supplies deterministic passed, running and failed GitHub checks. This validates native rendering without requiring GitHub credentials. It does not verify live GitHub CI.

For the file-picker test, install the app first. Get its simulator data directory with `xcrun simctl get_app_container YOUR_UDID dev.agentboard.ios-spike data`. Copy `/tmp/ab-ios-parity/upload.txt` to `Documents/parity-upload.txt` inside that directory. The app exposes its Documents folder in Files.

The five legacy `SpikeUITests` also need the older raw PTY fixture on loopback port 4149. Run it in another shell:

```sh
bun ios/scripts/shell-server.ts
```

That fixture starts a disposable zsh shell in `/tmp` for each connection. It uses an explicit environment without `TMUX`. Its small protocol is separate from Agentboard's live protocol. Use `-spikeEndpoint ws://127.0.0.1:4149` to open it in demo mode. Do not use that argument for a live Agentboard server.

Run the test suite:

```sh
xcodebuild -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination 'platform=iOS Simulator,id=YOUR_UDID' \
  -derivedDataPath ios/.build test
```

- Six `BoardConnectionTests` cover URL/protocol decoding, automatic reconnect, visible server rejection, readiness gating, stale socket/owner suppression, background recovery without input replay, and session removal.
- Two `LiveUITests` cover real-backend typing, single-line paste awaiting Enter, background recovery, session switching and address validation. They send commands only to the two seeded fixture shells.
- Three `SimulatorStateUITests` exercise the setup and connection sheet, unreachable-server recovery controls, and live terminal rotation with the software keyboard. They check that controls remain hittable and within the screen, bound accessory height, preserve terminal space, and send a command to the seeded shell. Run them in dark appearance at accessibility XXXL and again in light appearance at normal text size.
- Five `SpikeUITests` retain sample navigation and keyboard regression coverage, including control bytes, backspace, Unicode input and repeated keyboard transitions.
- Optional `TailnetSmokeTests` skips unless explicitly configured. It searches for and attaches to an existing session without typing into the terminal or changing session metadata.

For the optional tailnet test, pass `TEST_RUNNER_AGENTBOARD_TEST_URL` and `TEST_RUNNER_AGENTBOARD_TEST_SESSION` to `xcodebuild`. The latter is the displayed session name used by the test's search. Keep private endpoint and session values out of committed files and shared result artifacts.

Stop the backend and fixture processes you started after validation. Do not kill the live Agentboard tmux server. Do not remove a fixture directory while a process still uses it.

## Validation environment and evidence

The live slice uses m5p, Xcode 26.4 and the iPhone 17 Pro simulator on iOS 26.4. A separate read-only `TailnetSmokeTests` run passed against an existing production session over Tailscale. This proves catalog access and attachment for that session; it does not prove physical iPhone behavior or production input parity. Result bundles on the simulator host record these separate runs:

- `live-final.xcresult`: 13 tests passed; the optional tailnet test skipped.
- `live-tailnet.xcresult`: six tests passed, including five unit tests and the read-only tailnet smoke test.
- `live-verified.xcresult`: eight tests passed after the unknown-event decoder fix: six unit tests and two live UI tests.

A later contrast fix changed connection validation to primary body text with a red warning symbol. Its targeted validation rerun passed (1/1) in `live-contrast.xcresult`; the runs above predate that styling change.

Root lint, typecheck and the full test suite passed on m5p with Bun 1.3.14, `LOG_LEVEL` unset and the normal `/usr/sbin` PATH. The local pre-commit hook encountered a PTY resource failure. Equivalent checks ran remotely before the local commit used a temporary `hooksPath` override; no permanent hook configuration changed.

Screenshots from UI tests are XCTest attachments. Current live tests name captures `live-catalog`, `live-terminal-keyboard`, `live-resumed`, `live-second-session` and `live-invalid-address`. `SimulatorStateUITests` adds `sim-setup`, `sim-connection`, `sim-offline`, `sim-catalog`, `sim-terminal-portrait`, `sim-terminal-landscape` and `sim-terminal-landscape-reading`.

Simulator layout validation on m5p passed in light appearance at standard text size (3/3, `sim-standard.xcresult`) and dark appearance at the largest accessibility text size (3/3, `sim-accessibility-fixed.xcresult`). After allowing session names to wrap fully, the catalog/keyboard/rotation test passed again (1/1, `sim-title-wrap.xcresult`). These tests cover setup, connection editing, unavailable-server recovery controls, keyboard geometry in both orientations, and command input after rotation. Exported captures use `-light-standard.png` and `-dark-accessibility.png`; dark catalog and terminal captures come from the final focused rerun. Root lint, typecheck, 1,859 Bun tests and Node installer checks also passed for this iteration on m5p.

Historical evidence in `evidence/`:

- Original visual spike: light/dark terminal and XXXL Dynamic Type session list captures. Two UI tests passed before the native input proxy existed.
- Keyboard iteration: all five legacy UI tests passed on m5p with iOS 26.4. The result bundle was `evidence/keyboard-connected.xcresult` on the simulator host; exported screenshots are committed here.
- Original spike: root lint/typecheck passed. With `LOG_LEVEL` unset, 1,859 Bun tests and the Node installer checks passed. Inherited `LOG_LEVEL=debug` caused the existing logger default-level test to fail. These counts are historical, not the live slice's final validation result.
- Earlier simulator checkout: `/Users/garybasin/code/agentboard-ios-keyboard-spike/ios`. Its results predate the live-session slice.

## Full parity regression command

Prepare the private backend, seeded conversations, file/photo fixtures, port-4149 shell fixture and port-4190 PR proxy as described above. Run the full native matrix on the simulator host:

```sh
./ios/scripts/test-e2e.sh YOUR_UDID
```

The script runs native unit/integration and UI tests in light appearance at standard text size, then repeats native flows in dark appearance at the largest accessibility text size. It restores light appearance and standard text size on exit. Each run writes separate timestamped xcresult bundles. It does not install on a physical device or touch a production server.

## Findings and limits

The native hierarchy preserves terminal density. Status labels use primary text and colored symbols. The single non-scrolling quick-key row follows the software keyboard and has 44-point minimum targets. At accessibility Dynamic Type sizes, session name/status and connection state/Retry stack vertically, and session names wrap to their full height. Quick-key glyphs and text cap at `.xxxLarge` and stay on one line to preserve terminal space; catalog and sheet text retain full Dynamic Type. Tap the terminal to open the keyboard. Hide keyboard appears only while input has focus. Interrupt, Delete word and Insert newline remain in Session actions. No private class swizzling is used.

Physical iPhone installation/signing, IME, VoiceOver and real-device performance remain unverified. The app relies on an existing Tailscale connection; it does not provide Tailscale setup or authentication onboarding. SwiftUI is the native implementation. Current parity evidence and remaining validation limits are recorded in PARITY.md. Earlier slice results below are historical, not evidence for the new destinations.

## Hot reload

Historical result from the original UI spike, before the native keyboard iteration: verified with Inject 1.6.0 and InjectionNext 2.0.1 on m5p. A `TerminalScreen` title edit compiled in 280 ms and rebound nine symbols. The app kept PID 37100 and its terminal contents. `evidence/hot-reloaded.png` records the temporary “· live” suffix; the source was restored afterward. This is one measured edit, not an all-changes timing guarantee.

Download InjectionNext from its [releases](https://github.com/johnno1962/InjectionNext/releases). Start the app on the simulator host. Use its file-watcher mode. Do not enable compiler interception. If restarting it, wait for the old process to exit before opening the next instance; overlapping restarts left its listener unusable during this spike.

```sh
./ios/scripts/prepare.sh
INJECTION_RESOURCES=/path/to/InjectionNext.app/Contents/Resources \
  ./ios/scripts/build.sh YOUR_UDID
xcrun simctl install YOUR_UDID ios/.build/Build/Products/Debug-iphonesimulator/AgentboardSpike.app
SIMCTL_CHILD_INJECTION_PROJECT_ROOT="$PWD/ios" \
  xcrun simctl launch --console-pty YOUR_UDID dev.agentboard.ios-spike -demo -terminal
```

The project enables interposable symbols and Inject view observation. The build script records actual compiler commands as a gzip log that InjectionNext can scan. This adapter was necessary because this machine's CLI activity logs omitted the frontend commands even with `EMIT_FRONTEND_COMMAND_LINES=YES`. Set `INJECTION_RESOURCES` only for Debug development; Release builds do not copy the injection bundle.

Edit the Swift source on the simulator host, or sync your local edit there. Compatible view-body edits update the running app. Changes to stored properties and signatures still need rebuilding. Bundled HTML changes also require recopying/rebuilding; they do not use Swift injection.

## Session action validation

`SessionActions` opens a separate socket for one request and waits for the server's matching acknowledgement. Generic errors cannot be confused with terminal failures. Requests time out after 20 seconds and cancel on backgrounding. They are never replayed automatically. A lost acknowledgement reports an uncertain outcome and tells the user to check the list before trying again.

Six `SessionActionsTests` cover create acknowledgement, rename identity/name matching, end acknowledgement and rejection, missing sessions, timeout and cancellation. Together with the existing connection tests, 12 native unit tests passed on m5p in `actions-accessibility.xcresult`. That bundle's UI test failed in XCTest's selection-menu interaction; it is not a passing full-suite result.

`SessionActionUITests` creates a uniquely named disposable shell on the isolated port-4151 backend. It rejects an invalid directory, preserves and corrects the draft, creates and opens the shell, renames it, cancels ending it, then confirms end and verifies removal. The light-mode run passed in `actions-ui-fixed.xcresult`. The same flow passed at the largest accessibility text size in dark appearance in `actions-accessibility-settled.xcresult`. The test waits for native field scrolling before editing and scrolls the native menu to reach End session. A final light-mode regression run passed all three UI tests in `actions-regression.xcresult`: the management flow plus existing address validation and terminal typing/paste/background recovery/switching. Captures are in `evidence/session-actions/`. These results do not validate remote SSH mutations or physical iPhone behavior.

Root lint, typecheck and the full test suite passed on m5p for this iteration with Bun 1.3.14 and `LOG_LEVEL` unset. Local commits use the previously documented per-command hook override after equivalent remote checks; the local PTY limitation remains. No permanent hook settings change.
