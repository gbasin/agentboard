# Agentboard iPhone UI spike

SwiftUI navigation, session list, menus, connection sheet, and terminal keys around bundled xterm.js. Session data and management actions are local samples. The optional shell fixture provides a real PTY. It does not attach to tmux or live agents. This is a design experiment, not the production iOS client.

## Build

Use Xcode 26 and XcodeGen. Install the root Bun dependencies first.

```sh
./ios/scripts/prepare.sh
xcodebuild -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination 'platform=iOS Simulator,id=YOUR_UDID' \
  -derivedDataPath ios/.build build
xcrun simctl install YOUR_UDID ios/.build/Build/Products/Debug-iphonesimulator/AgentboardSpike.app
xcrun simctl launch YOUR_UDID dev.agentboard.ios-spike
```

The prepare script copies xterm and its licenses from the locked root dependencies. Generated vendor files and the Xcode project are ignored. Keep the bundled folder named `Web`: a top-level `Resources` folder makes macOS bundle discovery treat this iOS app as a different bundle layout and fail installation with “Missing bundle ID.”

## Try terminal input

Start the fixture on the simulator host:

```sh
bun ios/scripts/shell-server.ts
```

Open Connection in the app. Set `ws://127.0.0.1:4149`. Open a sample session. Each connection starts a disposable zsh shell in `/tmp`. Reconnect starts a new shell. The fixture binds only to loopback and uses an explicit environment without `TMUX`.

For a remote simulator, forward its loopback port to the fixture host:

```sh
ssh -N -o ExitOnForwardFailure=yes -R 4149:127.0.0.1:4149 macbook-m5p.local
```

Do not enter a production Agentboard WebSocket address. This fixture uses its own small protocol. Production attachment, authentication, Tailscale onboarding, and durable session recovery are future work.

## Test

Run the fixture before the UI tests.

```sh
xcodebuild -project ios/AgentboardSpike.xcodeproj -scheme AgentboardSpike \
  -destination 'platform=iOS Simulator,id=YOUR_UDID' \
  -derivedDataPath ios/.build test
```

The UI tests cover session navigation, software keyboard opening, the arrow popover, and native Enter sending a command to the real shell. The shell assertion checks output that does not appear verbatim in the command. Screenshots are XCTest attachments.

## Verified environment

- m5p, Xcode 26.4, iPhone 17 Pro simulator on iOS 26.4.
- Simulator ID: `94EEE322-8231-4D09-8904-5DE3EFAE934B`.
- Remote build copy: `/Users/garybasin/code/agentboard-ios-ui-spike/ios`.
- Light/dark terminal and XXXL Dynamic Type session list captured in `evidence/`.
- Two XCTest UI tests passed. Real PTY input also verified through dev-browser.
- Root lint/typecheck passed; the full test runner passed with `LOG_LEVEL` unset (1,859 Bun tests plus the Node installer checks). Inherited `LOG_LEVEL=debug` causes the existing logger default-level test to fail.

## Findings and limits

The native hierarchy fits the terminal workflow. Status labels use primary text and colored symbols for light-mode contrast. The quick-key strip follows the software keyboard and has 44-point minimum targets.

WKWebView retains its system previous/next/Done accessory. This costs a second row above the keyboard. Evaluate a public-API native input proxy or another terminal implementation in the next spike; do not use private class swizzling. Show/hide keyboard controls can also be consolidated.

This spike does not establish physical-device behavior, production reconnect correctness, selection/IME parity, media handling, or performance. Tailscale is the agreed v1 transport, not an implemented onboarding flow here. SwiftUI versus React Native remains open.

## Hot reload

Verified with Inject 1.6.0 and InjectionNext 2.0.1 on m5p. A `TerminalScreen` title edit compiled in 280 ms and rebound nine symbols. The app kept PID 37100 and its terminal contents. `evidence/hot-reloaded.png` records the temporary “· live” suffix; the source was restored afterward. This is one measured edit, not an all-changes timing guarantee.

Download InjectionNext from its [releases](https://github.com/johnno1962/InjectionNext/releases). Start the app on the simulator host. Use its file-watcher mode. Do not enable compiler interception. If restarting it, wait for the old process to exit before opening the next instance; overlapping restarts left its listener unusable during this spike.

```sh
./ios/scripts/prepare.sh
INJECTION_RESOURCES=/path/to/InjectionNext.app/Contents/Resources \
  ./ios/scripts/build.sh YOUR_UDID
xcrun simctl install YOUR_UDID ios/.build/Build/Products/Debug-iphonesimulator/AgentboardSpike.app
SIMCTL_CHILD_INJECTION_PROJECT_ROOT="$PWD/ios" \
  xcrun simctl launch --console-pty YOUR_UDID dev.agentboard.ios-spike -terminal
```

The project enables interposable symbols and Inject view observation. The build script records actual compiler commands as a gzip log that InjectionNext can scan. This adapter was necessary because this machine's CLI activity logs omitted the frontend commands even with `EMIT_FRONTEND_COMMAND_LINES=YES`. Set `INJECTION_RESOURCES` only for Debug development; Release builds do not copy the injection bundle.

Edit the Swift source on the simulator host, or sync your local edit there. Compatible view-body edits update the running app. Changes to stored properties and signatures still need rebuilding. Bundled HTML changes also require recopying/rebuilding; they do not use Swift injection.
