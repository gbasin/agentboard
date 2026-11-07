# Simulator evidence

Captured on m5p with Xcode 26.4, iOS 26.4, iPhone 17 Pro simulator (94EEE322-8231-4D09-8904-5DE3EFAE934B). Images are screenshots of the built app, not generated mockups. Session names, summaries, and transcript copy are illustrative samples.

- `sessions-light.png`: native session list.
- `terminal-light.png`, `terminal-dark.png`: xterm with native navigation and quick keys.
- `terminal-keyboard.png`: software keyboard and accessory strip.
- `terminal-arrows.png`: native directional-key popover.
- `sessions-large-dark.png`: XXXL Dynamic Type list.
- `live-shell.png`, `live-shell-keyboard.png`: real isolated shell output after native typing and Enter.
- `hot-reloaded.png`: temporary title suffix injected without relaunch. PID remained 37100. The suffix is not in final source.

Hot-reload console evidence:

```text
InjectionNext: arm64 iPhoneSimulator connected to app, waiting for commands.
[TerminalScreen.swift] Recompiling (SDKs/iPhoneSimulator)
Compiled in 280ms
Hot reload complete - Rebound 9 symbols, classes []
```

The initial review identified insufficient contrast in colored status text. The final implementation keeps semantic primary text and colors only the adjacent symbol. A separate finish review covers the recaptured affected screens.

Final finish-review verdict: ship the visual spike. The reviewer rechecked all eight refreshed screenshots and marked the sole material contrast finding resolved. This verdict does not cover production parity, Tailscale connectivity, or physical-device usability.

## Keyboard iteration

The `feat/ios-keyboard-spike` iteration replaces terminal-light, terminal-keyboard, terminal-arrows, live-shell, and live-shell-keyboard with current captures. `keyboard-before.png` preserves the original two-row layout. Dark-mode, large-type, and hot-reload captures above remain historical evidence from the first spike.

- `native-control-bytes.png`: the shell received Ctrl-C, Tab, Escape, Up, backspace, Enter, and UTF-8 é as the expected byte sequence.
- `native-paste.png`: the tested single-line paste waited for Enter; the keyboard returned after the sheet closed.
- `terminal-scroll-keyboard.png`, `terminal-keyboard-repeat.png`: scrolling and repeated dismissal/reopening.

All five XCTest UI tests passed on the simulator above. The result bundle is `keyboard-connected.xcresult` in the remote keyboard worktree's evidence directory. A fresh finish reviewer inspected the current captures and source and returned **ship this keyboard iteration as a visual/interaction spike**, with no required implementation fix. This does not certify physical devices, IME composition, VoiceOver, multiline paste, or every device size.

## Live-session slice

Current live captures come from `live-verified.xcresult` on the same m5p simulator: `live-catalog.png`, `live-terminal-keyboard.png`, `live-resumed.png`, and `live-second-session.png`. They use two disposable zsh windows on a real Agentboard backend with a private tmux socket and data directory. Repeated command markers are intentional test history. `live-invalid-address.png` comes from the later contrast correction in `live-contrast.xcresult`. No production session transcript is committed.

Validation on m5p:

- `live-final.xcresult`: 13 passed, 1 optional tailnet test skipped.
- `live-tailnet.xcresult`: 6 passed, including the explicit read-only Tailscale attachment.
- `live-verified.xcresult`: 8 passed after the event decoder was changed to ignore unrelated event payloads (6 unit, 2 live UI).
- `live-contrast.xcresult`: 1 validation UI test passed after the contrast fix.
- Root lint/typecheck and full tests passed with Bun 1.3.14 and `LOG_LEVEL` unset: 1,859 Bun tests plus Node installer checks. The remote PATH includes `/usr/sbin` for the reaper test's `lsof` query. Local pre-commit checks reached a macOS PTY resource failure, so the matching checks were completed remotely before committing with a one-command hook override. Repository hook settings were not changed.

These results do not certify signing/installation on a physical iPhone, IME, VoiceOver, multiline paste, all orientations or live dark-mode/Dynamic-Type rendering.

The finish reviewer requested primary validation text with a red symbol. After recapture, the reviewer scored that sole fix resolved and returned **ship**, at the scope of the contrast correction.
