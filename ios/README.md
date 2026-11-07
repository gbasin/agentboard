# Agentboard iPhone live-session slice

The app opens existing Agentboard sessions through native SwiftUI navigation. The default list groups live sessions by project and supports search. Enter the same base HTTP(S) URL you open in Safari. Keep Tailscale connected for a tailnet address.

`BoardConnection` owns a URLSession WebSocket at `/ws?catalog=2`. The catalog query is required for the live v0.40 backend. A proxy path prefix is preserved. WKWebView renders bundled xterm.js output and bridges input; a public-API UIKit `TerminalInputView` owns the keyboard. The connection uses heartbeat checks and reconnect backoff. Backgrounding closes the socket. Returning reconnects and restores the selected session. Disconnected input is never replayed. Each selection opens a fresh socket to isolate stale responses, including repeat visits to the same session ID.

This slice attaches to existing sessions only. Sleeping sessions and server-restricted remote sessions show a reason and cannot be opened. Live create, rename, end, history and media are not implemented. Sample management remains available with `-demo` or the legacy `-spikeEndpoint` launch argument.

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

## Isolated real-backend tests

Run the backend on the simulator host. Give it a dedicated socket directory and data directory. Remove inherited `TMUX`. Keep the backend running while the tests run.

```sh
mkdir -p /tmp/ab-ios-live
chmod 700 /tmp/ab-ios-live
env -u TMUX TMUX_TMPDIR=/tmp/ab-ios-live \
  AGENTBOARD_DATA_DIR=/tmp/ab-ios-live/data \
  TMUX_SESSION=ab-ios-live PORT=4151 bun run start
```

In a second shell, seed two disposable shell sessions. The seed script connects only to loopback port 4151.

```sh
bun ios/scripts/seed-live.ts
```

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

Screenshots from UI tests are XCTest attachments. Current live tests name captures `live-catalog`, `live-terminal-keyboard`, `live-resumed`, `live-second-session` and `live-invalid-address`.

Historical evidence in `evidence/`:

- Original visual spike: light/dark terminal and XXXL Dynamic Type session list captures. Two UI tests passed before the native input proxy existed.
- Keyboard iteration: all five legacy UI tests passed on m5p with iOS 26.4. The result bundle was `evidence/keyboard-connected.xcresult` on the simulator host; exported screenshots are committed here.
- Original spike: root lint/typecheck passed. With `LOG_LEVEL` unset, 1,859 Bun tests and the Node installer checks passed. Inherited `LOG_LEVEL=debug` caused the existing logger default-level test to fail. These counts are historical, not the live slice's final validation result.
- Earlier simulator checkout: `/Users/garybasin/code/agentboard-ios-keyboard-spike/ios`. Its results predate the live-session slice.

## Findings and limits

The native hierarchy preserves terminal density. Status labels use primary text and colored symbols. The single non-scrolling quick-key row follows the software keyboard and has 44-point minimum targets. Tap the terminal to open the keyboard. Hide keyboard appears only while input has focus. Interrupt, Delete word and Insert newline remain in Session actions. No private class swizzling is used.

Physical iPhone installation/signing, IME, VoiceOver, selection behavior, multiline paste parity and performance remain unverified. The app relies on an existing Tailscale connection; it does not provide Tailscale setup or authentication onboarding. SwiftUI is the implementation for this slice; this work does not establish full PWA feature parity.

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
