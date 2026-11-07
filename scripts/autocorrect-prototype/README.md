# iOS direct autocorrect prototype

The prototype streams each native text edit through Agentboard's xterm.js 6.0.0.
It preserves the hidden textarea as iOS's word context and translates edits into
terminal DEL characters plus replacement text. It is available in the isolated test page and an opt-in full-app build.
Ordinary Agentboard builds keep the adapter disabled.

## Run

1. Run `bun scripts/autocorrect-prototype/server.ts` from the repository root.
2. Open `http://localhost:18497/?adapter=1&pty=1`.
3. Select **Type in terminal**.
4. Type with the on-screen keyboard.

For a remote simulator, set `PROBE_HOST` to this machine's reachable address.
Open the same address on the simulator. The test server records typed text at
`/events`. Use test text only. Stop the server with Ctrl-C.

Omit `adapter=1` to test the attribute-only baseline. Omit `pty=1` to use the
simple local echo model. The PTY mode runs Python's readline input loop, which
prints each submitted line. It does not attach to tmux or an agent session.

Run the browser checks with:

```sh
dev-browser --headless --browser ab-autocorrect run scripts/autocorrect-prototype/browser-check.js
```

`native-typing.yaml` and `native-backspace.yaml` use Maestro to tap individual
keys. Run them in that order after opening the page on a dedicated simulator.
Select its UDID explicitly. Text injection and clipboard paste do not test
native autocorrect.

## Observed event flow

Baseline, on an iPhone 17 Pro simulator running iOS 26.4 on m5p:

| Step | iOS field | Terminal input buffer |
| --- | --- | --- |
| Type `teh` | `teh` | `teh` |
| Space keydown | `teh` | `teh ` |
| Native replacement input | `the` | `teh ` |
| Native space input | `the` plus NBSP | `teh ` |

With the adapter:

| Step | Adapter state (`sent`) | Terminal input buffer |
| --- | --- | --- |
| Type `teh` | `teh` | `teh` |
| Space keydown | `teh` | `teh` |
| Replacement input | `the` | `the` after two DELs and `he` |
| Space input | `the ` | `the ` |
| Return beforeinput | empty | submitted `the ` |
| Next word | tracks new word | new prompt receives new word |

Enter must also use the native edit path. iOS commits the pending correction
between Enter keydown and `beforeinput: insertLineBreak`. Sending Enter on
keydown would submit the typo before the correction arrives. The adapter lets
that correction finish, cancels the native line break, then emits one CR.

## Results

Native Safari, actual on-screen key taps, with the real PTY/readline loop:

- `teh`, space, Return: received `the `.
- `teh`, Return: received `the`.
- `dont`, space, delete, Return: received `don’t` (curly apostrophe).
- `ab`, delete, `c`, Return: received `ac`.
- Each Return submitted once. Characters streamed before Return.

Chromium checks cover replacement, ordinary typing, Enter, backspace, and
clearing the tracked context on arrow navigation. Unit tests cover the suffix
delta, length-changing replacements, duplicate updates, and surrogate pairs.
The browser's synthetic replacement is a regression check; native correction
was verified separately in the simulator.

Screenshots and event traces are in `evidence/`. Each trace entry records the
textarea value and selection or the emitted terminal bytes. The combined
`pty-and-browser.json` includes concurrent Chromium and simulator runs; sequence
numbers are local to each page. The earlier baseline has no sequence numbers,
so request arrival order can differ from event order.

## Full-app regression coverage

Run the browser-to-tmux suite:

```sh
E2E_PORT=18501 bunx playwright test --config playwright.autocorrect.config.ts
```

Four tests cover replacement-before-Return ordering, length-changing correction,
backspace, subsequent prompts, toolbar Return, manual paste, reconnect, and
session switching. They assert the real readline editor's submissions and save
WebSocket input frames. Synthetic browser events test transport and lifecycle;
they do not establish native iOS keyboard behavior.

Check the disabled ordinary build separately:

```sh
bun run build
E2E_PORT=18501 bunx playwright test tests/e2e/ios-autocorrect.spec.ts --grep 'ordinary build'
```

### Installed PWA on m5p

The full app passed six native-keyboard checks in an installed Home Screen PWA
on an iPhone 17 Pro simulator, iOS 26.4. Claude 2.1.319 and Codex 0.167.0 each
received exactly one corrected prompt for:

- `teh`, Return → `the`.
- `dont`, space, delete, Return → `don’t`.
- Home, reopen Agentboard, `teh`, space, Return → `the` (trimmed).

The checker asserts actual agent transcript entries. App telemetry confirms
`standalone: true`, standalone display mode, and the candidate adapter protocol.
Screenshots, executable Maestro flows, and assertions are in
[`evidence/full-app/native/`](evidence/full-app/native/).

Testing exposed a Codex behavior: raw replacement characters immediately
followed by Return left a newline in the draft. Sending the replacement suffix
as bracketed paste cleared this behavior. The same native-keyboard sequence
then submitted once in both agents. Ordinary typed characters still stream
individually. The adapter resets its context on session changes, reconnects,
toolbar input, programmatic paste, keyboard navigation, and blur.

To repeat the native checks:

1. Run `VITE_IOS_AUTOCORRECT_PROTOTYPE=1 bun run build`.
2. Run `bun scripts/autocorrect-prototype/serve-agentboard.ts`.
3. Record the printed private run directory.
4. Forward remote localhost port 18502 to the local server with SSH `-R`.
5. Open `http://localhost:18502` in simulator Safari.
6. Add Agentboard to the Home Screen with **Open as Web App** enabled.
7. Open Agentboard from the Home Screen.
8. Complete any first-run CLI prompts in the private test windows.
9. Submit one seed prompt per agent and locate their JSONL transcripts.
10. Run the checker with the SSH host, simulator UDID, run directory, and logs:

```sh
bun scripts/autocorrect-prototype/check-native.ts SSH_HOST UDID RUN_DIR CLAUDE_JSONL CODEX_JSONL
```

The checker requires Maestro and OpenJDK 21 on the simulator host. It taps real
keyboard keys. Its coordinates target the tested iPhone layout. Claude logs
are under `~/.claude/projects/`; Codex's `state_5.sqlite` maps the private
workspace to its rollout path. Use a dedicated simulator and test sessions.
Stop the server with Ctrl-C. It stops only its private tmux sessions.

## Remaining limits

The mode remains a build-time opt-in prototype, without a user-facing toggle.
Simulator testing does not replace testing on a physical iPhone.
TUI-driven text changes and native cursor selection can invalidate its local
suffix. Joined emoji, combining marks, CJK composition, dictation, and modifier
combinations need further tests; terminal deletion units vary by application.

Keep the mode opt-in. Native smart punctuation changes `dont` into `don’t`,
which is useful for prose but can alter command syntax. This prototype disables
automatic capitalization but retains the keyboard's correction behavior.
