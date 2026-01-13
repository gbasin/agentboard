# Agentboard

Web UI for tmux, optimized for agent TUI's (`claude`, `codex`, etc).

Made this because I got sick of using tmux kb shortcuts on my phone, and using Blink.

Run your desktop/server, then connect from your phone or laptop over Tailscale/LAN. Shared workspace across devices.

- iOS Safari mobile experience with:
  - Paste support (including images)
  - Touch scrolling
  - Virtual arrow keys / d-pad
  - Quick keys toolbar (ctrl, esc, etc.)

| Desktop | Mobile |
| :---: | :---: |
| <img src="assets/desktop.png" alt="Desktop" width="500"/> | <img src="assets/mobile.jpeg" alt="Mobile" width="200"/><br/><img src="assets/mobile-controls.jpeg" alt="Mobile controls" width="200"/> |

## Requirements

- Bun 1.3+
- tmux
- A network path to your machine (Tailscale, LAN, etc.)

## Usage

```bash
bun install
bun run dev
```

Open `http://<your-machine>:5173` (Vite dev server). In production, UI is served from the backend port (default 4040).

Production:
```bash
bun run build
bun run start
```

For persistent deployment on Linux, see [systemd/README.md](systemd/README.md).

## Keyboard Shortcuts

| Action | Mac | Windows/Linux |
|--------|-----|---------------|
| Previous session | `Ctrl+Option+[` | `Ctrl+Shift+[` |
| Next session | `Ctrl+Option+]` | `Ctrl+Shift+]` |
| New session | `Ctrl+Option+N` | `Ctrl+Shift+N` |
| Kill session | `Ctrl+Option+X` | `Ctrl+Shift+X` |

## Environment

```
PORT=4040
TMUX_SESSION=agentboard
REFRESH_INTERVAL_MS=5000
DISCOVER_PREFIXES=work,external
```

`DISCOVER_PREFIXES` lets you see windows from other tmux sessions (view-only).
