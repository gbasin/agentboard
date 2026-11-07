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
