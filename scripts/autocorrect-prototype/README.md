# iOS direct autocorrect prototype

The prototype streams each native text edit through Agentboard's xterm.js 6.0.0.
It preserves the hidden textarea as iOS's word context and translates edits into
terminal DEL characters plus replacement text. It is only loaded by this test
page. Agentboard's normal input path is unchanged.

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

## Before integration

This proves direct correction for prompt entry. It has not been tested in
Claude/Codex's prompt widgets or an installed PWA. Safari simulator testing does
not replace testing on a physical iPhone.

An app toggle must also reset context on session changes, reconnects, toolbar
keys, programmatic pastes, and other input outside this textarea. The adapter
currently resets for Enter, keyboard navigation/shortcuts, paste, and blur.
TUI-driven text changes and native cursor selection can invalidate its local
suffix. Joined emoji, combining marks, CJK composition, dictation, and modifier
combinations need further tests; terminal deletion units vary by application.

Keep the mode opt-in. Native smart punctuation changes `dont` into `don’t`,
which is useful for prose but can alter command syntax. This prototype disables
automatic capitalization but retains the keyboard's correction behavior.
