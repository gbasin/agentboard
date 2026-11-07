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
- This experiment establishes native text paste in a terminal fixture. It does
  not replace full Claude/Codex regression testing before shipping.
