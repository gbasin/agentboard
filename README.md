# Agentboard

[![CI](https://img.shields.io/github/actions/workflow/status/gbasin/agentboard/ci.yml?branch=master&logo=github)](https://github.com/gbasin/agentboard/actions)
[![npm](https://img.shields.io/npm/v/@gbasin/agentboard?logo=npm)](https://www.npmjs.com/package/@gbasin/agentboard)
[![License: MIT](https://img.shields.io/github/license/gbasin/agentboard)](https://github.com/gbasin/agentboard/blob/master/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/gbasin/agentboard)

Agentboard is a web UI for `tmux`, built for running coding agents such as Claude Code and Codex. Start your agents on a desktop or server, then watch and steer them from any browser, including your phone.

Every session lives in tmux, so your agents keep running when you close the tab, and the same sessions are available from every device.

<p align="center">
  <img src="assets/readme/hero.webp" width="880" alt="Agentboard in a desktop browser window, with a phone in front of it. The desktop sidebar lists agent sessions with their status, age, last prompt and pull request chips; one session waits for permission. The terminal shows a Claude Code session refactoring a router, with a Media 2 pill in its corner. The phone shows the same session's terminal with a quick-keys toolbar.">
</p>
<p align="center"><sub>The same tmux sessions on a laptop and a phone.</sub></p>

## Features

<table>
<tr>
<td width="40%" valign="top">

### Status and last prompt for every session

Each session shows a status inferred from its terminal output: *working*, *waiting for input*, or *needs permission*. Sessions matched to an agent transcript also show the last prompt you sent. Optional sounds tell you when a session needs permission or goes idle.

</td>
<td width="60%">
<img src="assets/readme/status-loop.gif" width="520" alt="Animation: the sidebar lists sessions with their last prompts and ages. The selected session, orders-migration, shows a permission prompt to run a database migration; its status badge changes to a raised hand while the prompt is open, then back to now when the prompt is answered.">
</td>
</tr>
<tr>
<td width="40%" valign="top">

### Subagent activity

For local Claude Code and Codex sessions, a counter on the session shows how many subagents are running. Click it to see the main session and each subagent with its current state and the time of its last activity signal.

</td>
<td width="60%">
<img src="assets/readme/subagents.webp" width="520" alt="The agent activity panel for the router-refactor session, opened from its subagent counter showing 3. The main session has an active model turn. Of four subagents, Migrate billing routes and Run e2e suite are waiting on Edit and Bash tool calls, Migrate invoice routes has an active model turn, and Audit auth middleware has finished.">
</td>
</tr>
<tr>
<td width="40%" valign="top">

### Pull requests with CI state

Pull requests that a session created with `gh pr create` appear as chips on the session, colored by state: open, draft, merged, or closed. Claude Code sessions also show pull requests that Claude Code linked to the session, such as one it pushed to. Hover a chip to see its title and CI checks.

</td>
<td width="60%">
<img src="assets/readme/pull-requests.webp" width="520" alt="Four sidebar sessions with pull request chips: a draft (489), two open (482 and 1193) and a merged one (1187). A hover card for pull request 1193 shows its title and four CI checks, one of them failing.">
</td>
</tr>
<tr>
<td width="40%" valign="top">

### Media from the transcript

A media rail collects the images, documents, and links from a session's transcript. Open any image in a viewer and step through the rest.

</td>
<td width="60%">
<img src="assets/readme/media-rail.webp" width="520" alt="The media rail open over a session's terminal: tabs for Media 5 and Links 1, then thumbnails for a PDF report, a search results screenshot, a CPU flame graph and two latency charts. Below it, the transcript lines where the agent read those files.">
</td>
</tr>
<tr>
<td width="40%" valign="top">

### History, Hibernate, and Wake

**Hibernate** closes an agent session's tmux window and keeps its conversation in the sidebar. It works for local sessions in the tmux session that Agentboard manages. **History** lists recent conversations: open one to preview its transcript, then **Wake** it to resume.

</td>
<td width="60%">
<img src="assets/readme/history.webp" width="520" alt="The transcript preview of a past Claude Code conversation, admin-react-19, about upgrading an app to React 19, with Cancel and Wake buttons.">
</td>
</tr>
<tr>
<td colspan="2">

### On your phone

On a small screen the board switches to a touch layout: a session drawer, a quick-keys toolbar (Esc, Tab, Ctrl, arrow keys, numbers), and a paste dialog. Touch scrolling, tap-to-click, and long-press selection work in the terminal. Add the board to your home screen as a PWA.

<img src="assets/readme/phone.webp" width="880" alt="Three phone screens. Left: the session drawer listing sessions with status, last prompt and pull request chips. Middle: a session waiting on a permission prompt, with a row of numbered session tiles at the top and the quick-keys toolbar at the bottom. Right: the paste dialog with three lines of text ready to submit.">

</td>
</tr>
<tr>
<td width="40%" valign="top">

### Sessions from other machines

Sessions from other machines appear on the same board over SSH, with a host badge on each one. Filter the board by host or by project. See [Remote hosts](docs/remote-hosts.md).

</td>
<td width="60%">
<img src="assets/readme/hosts.webp" width="520" alt="Five sidebar sessions from two machines: rows badged STUDIO run locally, rows badged BUILD-BOX run on a remote host. The remote Codex session nightly-e2e is selected.">
</td>
</tr>
</table>

### Also

- A full terminal in the browser. Mouse scrolling, selection, and the clipboard work with Claude Code's fullscreen renderer.
- Paste or drop text, images, and files into the prompt.
- Keyboard shortcuts to switch, create, and close sessions.
- Sort by age or by what needs attention, filter by project or host, or drag sessions into your own order.
- Session recovery lists the sessions that a crash or reboot interrupted, so you can reopen them. Automatic reopening is opt-in. See [Session recovery](docs/session-recovery.md).

## Supported agents

| Agent | Matching, last prompt, Wake | Pull requests | Media rail | Subagent activity |
| --- | :---: | :---: | :---: | :---: |
| Claude Code | Yes | Yes | Yes | Yes |
| Codex | Yes | Yes | Yes | Yes |
| Pi | Yes | Yes | Links | |
| oh-my-pi | Yes | Yes | Links | |
| Devin CLI | Yes | Yes | Links | |
| Grok CLI | Yes | Yes | Links | |

The media rail shows images, documents, and links for Claude Code and Codex. For the other agents it shows links.

Agentboard finds each agent's transcripts in its default location and matches them to tmux windows automatically. Any other program that runs in tmux also works as a plain terminal session, with status but no transcript features.

## Requirements

- macOS (Apple Silicon or Intel) or Linux (x64 or arm64).
- tmux 3.2 or later: `brew install tmux` or `apt install tmux`.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`): `brew install ripgrep` or `apt install ripgrep`. Agentboard uses it to match agent transcripts to tmux windows. The Homebrew and npm packages do not install it.
- [Tailscale](https://tailscale.com/download) (recommended) or another network path to your machine, for access from other devices.

Optional:

- The [GitHub CLI](https://cli.github.com/) (`gh`), signed in, to show pull request state and CI checks.
- `ssh` with key-based access, to show sessions from [remote hosts](docs/remote-hosts.md).

## Install

### Homebrew

```bash
brew tap gbasin/tap
brew install agentboard
agentboard
```

### npm

Requires Node.js 18 or later.

```bash
npm install -g @gbasin/agentboard
agentboard
```

Or run it without installing:

```bash
npx @gbasin/agentboard
```

### Open the board

Open `http://localhost:4040` on the same machine.

If Tailscale is running, Agentboard also listens on your Tailscale address. Open `http://<your-machine>:4040` from any device on your tailnet. To install the board on your phone's home screen, see [PWA installation](docs/pwa-install.md).

Without Tailscale, Agentboard accepts connections from the same machine only. To change that, see [Network and security](docs/configuration.md#network-and-security).

### Run it as a service

To start Agentboard at login and keep it running:

- macOS: [launchd/README.md](launchd/README.md)
- Linux: [systemd/README.md](systemd/README.md)

### Upgrade

Run `brew upgrade agentboard` or `npm install -g @gbasin/agentboard@latest`, then restart Agentboard. Your tmux sessions keep running across the restart, and your data stays in `~/.agentboard`.

### From source

See [Development](docs/development.md).

## Configuration

Agentboard is configured with environment variables. It has no command-line flags.

```bash
PORT=8080 TMUX_SESSION=work agentboard
```

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4040` | Port for the web UI. |
| `HOSTNAME` | `127.0.0.1` | Address to bind. Set `0.0.0.0` to listen on all interfaces. |
| `TMUX_SESSION` | `agentboard` | Name of the tmux session that Agentboard manages. |
| `DISCOVER_PREFIXES` | unset | Limits which of your other tmux sessions appear on the board. By default, all of them appear. |
| `AGENTBOARD_REMOTE_HOSTS` | unset | SSH hosts to show on the board. |
| `AGENTBOARD_DATA_DIR` | `~/.agentboard` | Directory for the database and logs. |

See [Configuration](docs/configuration.md) for every setting.

Appearance, notification sounds, command presets, session list options, and terminal options are in the **Settings** dialog in the UI.

> **Security note:** Agentboard has no built-in authentication. Anyone who can reach the server has full access to your terminal sessions, including the ability to run commands as your user. The default localhost binding is safe. Tailscale provides network-level auth for remote access. Avoid setting `HOSTNAME=0.0.0.0` on untrusted networks (public WiFi, shared LANs) without an additional access control layer.

## Keyboard shortcuts

| Action | Mac | Windows/Linux |
|--------|-----|---------------|
| Previous session | `Ctrl+Option+[` | `Ctrl+Shift+[` |
| Next session | `Ctrl+Option+]` | `Ctrl+Shift+]` |
| Jump to session 1-9 | `Ctrl+Option+1..9` | `Ctrl+Shift+1..9` |
| New session | `Ctrl+Option+N` | `Ctrl+Shift+N` |
| Kill session | `Ctrl+Option+X` | `Ctrl+Shift+X` |
| Settings | `Ctrl+Option+,` | `Ctrl+Shift+,` |

To use a different modifier, open **Settings** > **Terminal**.

## How it works

```
┌─────────────┐    SSH     ┌─────────────┐
│ Remote Host ├───────────►│             │   WebSocket   ┌────────────┐
│ (tmux)      │            │  Agentboard ├──────────────►│  Browser   │
└─────────────┘    tmux    │  Server     │               │  (React +  │
┌─────────────┐    CLI     │             │               │  xterm.js) │
│ Local tmux  ├───────────►│  - discover │               └────────────┘
│ sessions    │            │    sessions │
└─────────────┘            │  - parse    │
┌─────────────┐    read    │    agent    │
│ Agent logs  ├───────────►│    logs     │
│             │            └─────────────┘
└─────────────┘
```

- **Session discovery:** The server polls local tmux windows and, if you configure them, remote hosts over SSH.
- **Status inference:** The server reads pane content to tell if each agent is *working*, *waiting for input*, or *asking for permission*.
- **Log matching:** The server reads agent transcripts to match each session to its tmux window and to show its last prompt, pull requests, and media.
- **Live terminal:** The server streams terminal I/O to the browser, so you can use any session from any device.
- **Hibernating and History sessions:** The sidebar keeps dormant agent sessions, and you wake one when you need it. Startup does not wake hibernating or History sessions.

## Documentation

- [Configuration](docs/configuration.md): every environment variable.
- [Remote hosts](docs/remote-hosts.md): sessions from other machines over SSH.
- [Session recovery](docs/session-recovery.md): reopen sessions after a crash or reboot.
- [PWA installation](docs/pwa-install.md): add the board to your phone's home screen.
- [macOS service](launchd/README.md) and [Linux service](systemd/README.md).
- [Development](docs/development.md): run from source and contribute.
- [Security policy](SECURITY.md).
