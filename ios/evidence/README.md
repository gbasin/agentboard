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
