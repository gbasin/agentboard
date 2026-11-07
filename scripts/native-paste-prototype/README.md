# Native iOS terminal paste prototype

The opt-in build gives xterm's input textarea a transparent 44-point target
across the current cursor row. Tap the prompt to focus it. Long-press that row
and select the native iOS **Paste** action.

The textarea must have opacity 1 and sit above the accessibility mirror.
Its text, background and caret remain transparent. xterm still controls its
vertical position. Touches on this target bypass Agentboard's long-press
mouse-selection handler. Native paste uses the existing browser paste pipeline.
The toolbar Paste button remains available.

## Run

1. Run `VITE_IOS_NATIVE_PASTE_PROTOTYPE=1 bun run build`.
2. Run `bun scripts/native-paste-prototype/serve-agentboard.ts`.
3. Record the printed run directory.
4. Open `http://localhost:18512`.

The server creates a private tmux socket, database and byte-recording terminal.
It does not attach to live sessions or execute pasted text. Stop it with Ctrl-C.
Ordinary builds leave this prototype disabled.

For a remote simulator, forward port 18512 with SSH:

```sh
ssh -N -R 18512:127.0.0.1:18512 USER@HOST
```

1. Open the forwarded URL in simulator Safari.
2. Add Agentboard to the Home Screen with **Open as Web App** enabled.
3. Launch Agentboard from the Home Screen.
4. Set the simulator clipboard to `PWA_native_alpha`, a newline, and `PWA_native_beta`.
5. Run `pwa-paste.yaml` with Maestro and an explicit simulator UDID.
6. Run the byte assertion against the printed run directory:

```sh
bun scripts/native-paste-prototype/check-input.ts RUN_DIR/input.jsonl
```

The flow coordinates target an iPhone 17 Pro at the fixture's initial prompt.
Use a fresh fixture for each run. The input log includes test clipboard contents.

## Verified on m5p

An iPhone 17 Pro simulator running iOS 26.4 showed the native Paste/AutoFill
menu in both Safari and an installed Home Screen PWA. Client telemetry confirmed
`standalone: true` and a 383 × 44 CSS-pixel textarea target.

The PWA delivered exactly one sequence:

```text
ESC[200~PWA_native_alpha CR PWA_native_beta ESC[201~
```

The line break stayed inside the paste markers. No extra Enter followed it.
The fixture enabled mouse reporting during this test. Focus generated a mouse
click, which is recorded separately from the paste.

See [the native menu](evidence/pwa-native-menu.png),
[the pasted text](evidence/pwa-pasted.png), and [the input trace](evidence/input.jsonl).
The fixture renders carriage returns as line breaks for the screenshot.

`bun run lint`, `bun run typecheck`, and the full `bun run test` suite passed.
Tests required `LOG_LEVEL` to be unset: an inherited `debug` setting breaks the
existing test for the logger's default level. A dev-browser check confirmed the
experimental target is absent on desktop. The UI detector reported no findings.

## Limits

- With the keyboard closed, the first gesture focuses the input. Long-press
  after focus opens the menu.
- The native target covers the current cursor row and part of the row below.
  That area offers editing actions instead of output selection.
- Output outside the target retains the existing selection and scroll handlers.
  The raw fixture cannot establish copy behavior in every agent TUI.
- Physical iPhones, landscape, cursor movement under an open menu, images,
  and interaction with the separate autocorrect prototype need further tests.
- Native checks cover one portrait layout in each CLI, not every prompt layout.

## Claude and Codex end-to-end verification

The installed PWA passed native Paste with Claude Code 2.1.319 and Codex 0.167.0
on the same m5p simulator. Both ran in their normal alternate screen with mouse
reporting. Each received two lines through the iOS Paste menu. The transcript
remained unchanged until Return, then contained exactly one new prompt with the
original multiline text. No toolbar Paste button or synthetic paste event was
used in these native checks.

Native XCTest hold-and-drag gestures on output above the prompt opened the
existing Copy selection offer in both CLIs. Tapping Copy put the selected
`SELECTABLE_OUTPUT` substring in the simulator clipboard. See the
[results](evidence/agents/paste-results.json),
[Claude menu](evidence/agents/claude-menu.png),
[Codex menu](evidence/agents/codex-menu.png),
[Claude selection](evidence/agents/claude-selection.png), and
[Codex selection](evidence/agents/codex-selection.png).

### Repeat the native checks

1. Build the opt-in prototype.
2. Run `bun scripts/native-paste-prototype/serve-agentboard.ts --agents`.
3. Open the isolated board in the installed PWA.
4. In each CLI, submit `Generate test output: 20 numbered lines containing SELECTABLE_OUTPUT. Do not use tools.`
5. Locate that CLI's transcript by its printed workspace path.
6. Save the exact multiline clipboard text in a file without a trailing newline.
7. Run `assert-agent-paste.ts before AGENT TRANSCRIPT SNAPSHOT` with Bun.
8. Set the simulator clipboard with `xcrun simctl pbcopy UDID < TEXT_FILE`.
9. Tap the prompt, long-press it, and tap the native Paste action.
10. Run `assert-agent-paste.ts held AGENT TRANSCRIPT SNAPSHOT` with Bun.
11. Tap the native Return key.
12. Wait for the transcript to update.
13. Run `assert-agent-paste.ts submitted AGENT TRANSCRIPT SNAPSHOT TEXT_FILE` with Bun.

`AGENT` is `claude` or `codex`. The checker compares all typed prompts against
the baseline. Keep transcripts out of version control; they contain session data.

For native output selection, close the keyboard and run this on the simulator
host from `native-gestures/`:

```sh
xcodebuild test -project NativeGestures.xcodeproj -scheme NativeGestures \
  -destination "platform=iOS Simulator,id=UDID" \
  -derivedDataPath /tmp/abnp-native-build -parallel-testing-enabled NO \
  CODE_SIGNING_ALLOWED=NO
```

The tests assume Claude is the first drawer row, Codex is the second, and the seeded output is visible.
They hold and drag within output, then assert and tap Copy selection. Screenshots
are attached to the XCTest result. To verify clipboard contents separately, run
one test at a time with `-only-testing:NativeGestures/NativeGestureTests/testClaudeOutputSelection`
or `testCodexOutputSelection`, then run `xcrun simctl pbpaste UDID`.
The drag starts away from the drawer's edge-swipe zone.

### Browser regression coverage

`tests/e2e/native-paste.spec.ts` checks opt-in gating, the 44-pixel input target,
output hit-testing and DOM selection, suppression of remote mouse selection on
the input, preservation of remote mouse selection on output, and multiline paste
held until Enter without a keyboard shortcut. Chromium cannot test the iOS menu;
the native checks above cover that behavior.

```sh
VITE_IOS_NATIVE_PASTE_PROTOTYPE=1 bun run build
IOS_NATIVE_PASTE_E2E=1 E2E_PORT=18513 bunx playwright test tests/e2e/native-paste.spec.ts --workers=1
bun run build
IOS_NATIVE_PASTE_E2E=0 E2E_PORT=18513 bunx playwright test tests/e2e/native-paste.spec.ts --workers=1
```

Both build variants passed (two browser tests each). Lint, typecheck, and the full
unit/integration suite also passed. No physical-device coverage is claimed.

CI runs the ordinary build plus a separate opt-in build of this spec. The
`e2e-native-paste-attempt-*` Actions artifact includes the HTML report and screenshots
of the input target, held paste, and submitted paste. Native iOS callout evidence
is recorded separately above; Chromium screenshots are not native callout proof.

## PR integration recheck

Integrated `master` at `6d38500`, including default-on iOS autocorrect and
fullscreen TUI selection handling. Repeated native multiline Paste in both CLIs
with autocorrect enabled in the installed PWA. Server telemetry confirmed
standalone mode and the autocorrect adapter. Both transcript assertions passed:
no new prompt before Return, exactly one unchanged multiline prompt after Return.

Current screenshots: [Claude menu](evidence/current/claude-menu.png),
[Claude held draft](evidence/current/claude-held.png),
[Codex menu](evidence/current/codex-menu.png),
[Codex held draft](evidence/current/codex-held.png).
The older screenshots above document the initial prototype, before this integration.

The browser spec now has three tests. It verifies that fullscreen TUIs retain
their mouse-selection path and suppress native DOM selection, while plain terminal
output remains natively selectable. This matches the selection policy on master.

Both native hold-and-drag selection tests passed after integration. Evidence:
[Claude selection](evidence/current/claude-selection.png),
[Codex selection](evidence/current/codex-selection.png),
[assertion results](evidence/current/results.json), and
[standalone/autocorrect telemetry](evidence/current/telemetry.json).
Codex's copied output was also read back from the simulator clipboard.
