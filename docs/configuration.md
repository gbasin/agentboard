# Configuration

Agentboard reads its configuration from environment variables when it starts. It has no configuration file of its own and no command-line flags: an argument such as `--port` is ignored. Restart the server after you change a variable.

Bun, the runtime that Agentboard uses, loads `.env`, `.env.<NODE_ENV>`, `.env.local`, and `.env.<NODE_ENV>.local` from the directory where the server starts. This includes the Homebrew and npm binaries. Variables in those files apply to Agentboard without any message, so check for a `.env` file that sets `PORT` or `HOSTNAME` before you start Agentboard inside a project directory. With `bun run`, Bun reads the files from the checkout.

Settings that you change in the **Settings** dialog are separate. Agentboard stores them in its database or in your browser, and they do not need a restart.

## Set a variable

| How you run Agentboard | Where to set variables |
| --- | --- |
| From a shell (`agentboard`, `npx`, `bun run start`) | In the shell: `PORT=8080 agentboard` |
| launchd, release mode | `~/.agentboard/service-env.json` (string values), then run `./launchd/upgrade.sh`. The installer copies the values into the service; a restart alone does not apply them. Removing a key from the file does not remove it from the service. TLS and custom bind addresses are not accepted in this mode. See [launchd/README.md](../launchd/README.md#configure-the-release-service). |
| launchd, source mode | A `.env.local` file in the checkout, then restart the service. The installer generates the service wrapper and overwrites manual changes to it when it runs again. |
| systemd | A drop-in: `systemctl --user edit agentboard`, add `Environment=NAME=value` lines under `[Service]`, then run `systemctl --user restart agentboard`. A `PATH` entry in the drop-in replaces the unit's `PATH`. A `.env.local` file in the checkout also works. |

## Most-used settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4040` | Port for the web UI and WebSocket. |
| `HOSTNAME` | `127.0.0.1` | Address to bind. See [Network and security](#network-and-security). |
| `TMUX_SESSION` | `agentboard` | Name of the tmux session that Agentboard manages. |
| `DISCOVER_PREFIXES` | unset | Limits which other tmux sessions appear on the board. |
| `AGENTBOARD_REMOTE_HOSTS` | unset | SSH hosts to show on the board. See [Remote hosts](remote-hosts.md). |
| `AGENTBOARD_DATA_DIR` | `~/.agentboard` | Directory for the database, logs, and lock files. |
| `TLS_CERT`, `TLS_KEY` | unset | Certificate and key files. Set both to serve HTTPS. |
| `PREVIEW_TLS_CERT`, `PREVIEW_TLS_KEY` | unset | Certificate and key files for separate preview origins behind an HTTPS proxy; falls back to `TLS_CERT`/`TLS_KEY`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

## Network and security

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `4040` | Port for the web UI and WebSocket. The Vite dev server proxies to this port. |
| `HOSTNAME` | `127.0.0.1` | Address to bind. |
| `TLS_CERT` | unset | Path to a TLS certificate file. |
| `TLS_KEY` | unset | Path to the TLS private key file. |
| `AGENTBOARD_ALLOWED_ORIGINS` | unset | Comma-separated origins, such as `https://board.example.com`, that may use the board in addition to the server's own origin. |

`HOSTNAME` controls which interfaces the server binds to. The default, `127.0.0.1`, accepts connections from the same machine only. Set `0.0.0.0` to listen on all interfaces.

When `HOSTNAME` is `127.0.0.1` and Tailscale is detected, the server also binds to your Tailscale IP. Other devices on your tailnet can then reach the board with no extra configuration. This does not happen for other values, including `localhost`.

A `HOSTNAME` that equals the machine hostname is treated as auto-exported by the environment (containers and some CI images do this). The server ignores it, logs a warning, and keeps the `127.0.0.1` default.

Set both `TLS_CERT` and `TLS_KEY` to serve HTTPS. Use absolute paths. To install the board as a PWA, the browser needs HTTPS or `localhost`; see [pwa-install.md](pwa-install.md).

**HTTPS previews behind a reverse proxy.** The browser requests previews with its dashboard protocol. `X-Forwarded-Proto: https` also selects HTTPS for direct output links. HTML, visualization, and local-app previews use a separate port and origin; that port must be reachable from the viewing device. They are not served beneath the dashboard origin.

For a dashboard opened using this machine's `*.ts.net` name, Agentboard obtains a preview certificate automatically through the local `tailscale` CLI. Tailscale HTTPS must be enabled and the service user must be allowed to run `tailscale cert`. The hostname must match `Self.DNSName` from local Tailscale status. Agentboard requests at least 24 hours of certificate validity, caches certificates for at most one hour, and refreshes active preview listeners without changing their URLs. Temporary certificate exports are private and removed after reading; Tailscale owns its persistent certificate cache. This does not change Tailscale Serve configuration.

For other HTTPS proxies, set both `PREVIEW_TLS_CERT` and `PREVIEW_TLS_KEY` to absolute paths containing a certificate for the dashboard hostname. The dashboard can remain HTTP behind the proxy. Your certificate manager renews these files; Agentboard rereads them hourly and rebinds preview listeners while existing connections drain. Without a usable certificate, the preview displays a setup error instead of loading an HTTP iframe. Plain HTTP dashboards continue to use HTTP previews.

**Allowed origins.** The server rejects a WebSocket handshake or a write request (any method except `GET`, `HEAD`, and `OPTIONS`) with 403 when the browser's `Origin` does not match the request's `Host` header. When Agentboard serves TLS itself (`TLS_CERT` and `TLS_KEY` are set), the `Origin` must also use `https`. Requests without an `Origin` header, such as curl and scripts, are not affected. If a reverse proxy rewrites `Host`, for example to `127.0.0.1:4040`, list the public origin in `AGENTBOARD_ALLOWED_ORIGINS`. A proxy that forwards the original `Host`, such as Tailscale Serve, needs no entry.

Write each entry as a full origin: the scheme, the host, and the port if it is not the default for the scheme. Examples are `https://board.example.com` and `http://nuc:8080`. Separate entries with commas. An entry matches exactly, scheme included. Do not add a path, a query, or credentials. Wildcards do not work. Agentboard ignores an entry that it cannot parse and prints no message. See [SECURITY.md](../SECURITY.md#browser-protections-and-their-limits) for what this check does not cover.

> **Security note:** Agentboard has no built-in authentication. Anyone who can reach the server has full access to your terminal sessions, including the ability to run commands as your user. The default binding accepts connections only from this machine and, when Tailscale answers at startup, from the tailnet devices that your Tailscale access rules allow. It does not stop other programs and users on this machine, and the browser checks do not cover DNS rebinding or cross-site `GET` requests; see [SECURITY.md](../SECURITY.md#browser-protections-and-their-limits). Avoid setting `HOSTNAME=0.0.0.0` on untrusted networks (public WiFi, shared LANs) without an additional access control layer.

## tmux sessions and discovery

| Variable | Default | Effect |
| --- | --- | --- |
| `TMUX_SESSION` | `agentboard` | Name of the managed tmux session. New sessions become windows in it. |
| `DISCOVER_PREFIXES` | unset | Comma-separated prefixes. When set, only tmux sessions whose names start with one of them are discovered. The same filter applies on remote hosts. |
| `ALLOW_KILL_EXTERNAL` | `false` | Set `true` to allow the UI to kill discovered (external) sessions. |
| `AGENTBOARD_PREFER_WINDOW_NAME` | `false` | Set `true` to label discovered sessions by tmux window name. |
| `PRUNE_WS_SESSIONS` | `true` | Set `false` to keep orphaned `<TMUX_SESSION>-ws-*` sessions at startup. |
| `REFRESH_INTERVAL_MS` | `2000` | Interval between tmux window refreshes. |
| `TMUX_TMPDIR` | unset | Standard tmux variable. When set, Agentboard uses a tmux server on a private socket in that directory. |
| `AGENTBOARD_ALLOW_NESTED_TMUX` | unset | Set `true` to allow the server to start inside one of its own tmux panes. |

**Discovery.** Agentboard shows windows from every tmux session, not only the one it manages. If `DISCOVER_PREFIXES` is unset, all sessions except the managed one are discovered. Windows named `__agentboard_root__` are always hidden; that name is reserved for the placeholder that keeps a base session alive.

**Labels.** With `AGENTBOARD_PREFER_WINDOW_NAME=false`, a discovered session is labeled with its tmux session name. That name is more meaningful than a window name that follows the running process under tmux `automatic-rename on`. Set `true` to use the tmux window name when it is non-empty and distinct from the session name. This is useful when you keep one shared session (for example `dev`) with one explicitly-named window per project. The **Settings** dialog has the same option, and a value saved there overrides the variable.

**Grouped sessions.** When you open a discovered tmux session, Agentboard attaches through a per-connection session grouped with it (`<TMUX_SESSION>-ws-<connection>-x-<session>-<hash>`), so focus in the browser stays independent of your own tmux clients. Two side effects:

- These derived sessions appear in `tmux ls` while a viewer is attached. Agentboard removes the session for a discovered tmux session when you switch away from it, and the rest when it closes the terminal. After a disconnect, the relay keeps the terminal for up to 60 seconds (`AGENTBOARD_RELAY_GRACE_MS`) so that the browser can reconnect. Startup prunes the ones that an earlier server left behind.
- Killing the raw session keeps its windows alive until the last grouped viewer switches away. tmux keeps a group's windows while any member session exists.

**Nested tmux.** The server refuses to start from a pane of a tmux session that an Agentboard manages, because every tmux command would then target that live server. It also refuses when it cannot determine which session the pane belongs to. To run a second instance, give it a private socket with `TMUX_TMPDIR` and its own `AGENTBOARD_DATA_DIR`. With `TMUX_TMPDIR` set, Agentboard creates the directory and ignores the inherited `TMUX` value. `AGENTBOARD_ALLOW_NESTED_TMUX=true` removes the check and shares the socket on purpose.

## Terminal

| Variable | Default | Effect |
| --- | --- | --- |
| `TERMINAL_MODE` | `pty` | Terminal I/O strategy: `pty`, `pipe-pane`, or `auto`. |
| `TERMINAL_MONITOR_TARGETS` | `true` | `pipe-pane` mode only. Set `false` to stop polling tmux for closed targets. |
| `AGENTBOARD_CLAUDE_NO_FLICKER` | on | Set `0` or `false` to launch Claude Code without its fullscreen renderer. |
| `AGENTBOARD_TMUX_SET_CLIPBOARD` | on | Set `0` or `false` to leave tmux's `set-clipboard` option unchanged. |
| `AGENTBOARD_TMUX_SYNC` | on | Set `0` or `false` to stop advertising synchronized-update support. |

**`TERMINAL_MODE`.** `pty` attaches a tmux client through a grouped session, on a PTY that Agentboard allocates. It works under launchd and systemd, which run the server without a terminal. `pipe-pane` uses `tmux pipe-pane` and no PTY. `auto` selects `pty` when the server has a terminal on stdin and `pipe-pane` when it does not.

**`AGENTBOARD_CLAUDE_NO_FLICKER`.** By default, Agentboard sets `CLAUDE_CODE_NO_FLICKER=1` on newly-created panes so Claude Code uses its fullscreen renderer with mouse scrolling, click handling, in-app selection, and flat memory usage for long conversations. Fullscreen rendering requires Claude Code v2.1.89 or later; older versions ignore the variable and use the classic renderer.

Reasons to opt out: fullscreen rendering keeps the conversation in the alternate screen buffer instead of native terminal scrollback, so terminal-level search and copy workflows behave differently. Claude also captures mouse events unless you disable its mouse capture. Inside Claude Code, run `/tui default` to switch a session back to the classic renderer, or launch Claude with `CLAUDE_CODE_DISABLE_MOUSE=1` if you want fullscreen rendering but native mouse selection.

**`AGENTBOARD_TMUX_SET_CLIPBOARD`.** By default, Agentboard enables tmux's `set-clipboard on` when it attaches in `pty` mode. Copies made inside a session then land in a tmux paste buffer that Agentboard relays to the browser clipboard. This matters on iOS Safari, where the async OSC 52 path cannot satisfy the user-gesture rule. `set-clipboard` is a server-global tmux option, so this affects your whole tmux server and is not reverted on disconnect.

**`AGENTBOARD_TMUX_SYNC`.** By default, Agentboard's tmux client advertises synchronized-update support (`tmux -T sync`, tmux 3.2 or later). tmux then wraps redraws in DEC 2026 frame markers, and the browser terminal paints each frame atomically instead of tearing during fast fullscreen repaints. The flag applies only to Agentboard's own client, in `pty` mode, and does not change tmux server options. Agentboard skips it when tmux is older than 3.2.

## Session list and history

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_INACTIVE_MAX_AGE_HOURS` | `24` | How far back the **History** section looks. |
| `AGENTBOARD_EXCLUDE_PROJECTS` | unset | Comma-separated project paths to hide from **Hibernating** and **History**. |
| `AGENTBOARD_HOST` | machine hostname | Host label for local sessions. |

**`AGENTBOARD_INACTIVE_MAX_AGE_HOURS`.** History shows up to 100 recent entries inside this window. The **Settings** dialog has the same option, and a value saved there overrides the variable. The variable name is kept for compatibility.

**`AGENTBOARD_EXCLUDE_PROJECTS`.** Each entry is a path prefix: `/workspace` also hides `/workspace2`. Use `<empty>` to hide conversations that have no project path. This is useful for hiding automated sessions. The filter applies to the **Hibernating** and **History** sections. A live tmux window always appears.

## Agents

Agentboard finds each agent's transcripts in the agent's default location and resumes a dormant session with the agent's own resume command. Override either when your setup differs.

| Agent | Transcript location | Location override | Resume command (default) | Resume override |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/` | `CLAUDE_CONFIG_DIR` | `claude --resume {sessionId}` | `CLAUDE_RESUME_CMD` |
| Codex | `~/.codex/sessions/` | `CODEX_HOME` | `codex resume {sessionId}` | `CODEX_RESUME_CMD` |
| Pi | `~/.pi/agent/sessions/` | `PI_HOME` | `pi --session {logFilePath}` | `PI_RESUME_CMD` |
| oh-my-pi | `~/.omp/agent/sessions/` | `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` | `omp --resume {logFilePath}` | `OMP_RESUME_CMD` |
| Devin CLI | `~/.local/share/devin/cli/` | `DEVIN_CLI_DIR`, `XDG_DATA_HOME` | `devin --resume {sessionId}` | `DEVIN_RESUME_CMD` |
| Grok CLI | `~/.grok/sessions/` | `GROK_HOME` | `grok --resume {sessionId}` | `GROK_RESUME_CMD` |

The overrides do not all name the same level of the path:

| Variable | Example | Agentboard reads |
| --- | --- | --- |
| `CLAUDE_CONFIG_DIR` | `/data/claude` | `/data/claude/projects/` |
| `CODEX_HOME` | `/data/codex` | `/data/codex/sessions/` |
| `PI_HOME` | `/data/pi` | `/data/pi/agent/sessions/` |
| `PI_CODING_AGENT_DIR` | `/data/omp-agent` | `/data/omp-agent/sessions/` |
| `PI_CONFIG_DIR` | `.custom-omp` | `~/.custom-omp/agent/sessions/`. The value is a directory name in your home directory. |
| `DEVIN_CLI_DIR` | `/data/devin-cli` | `/data/devin-cli/sessions.db` |
| `XDG_DATA_HOME` | `/data` | `/data/devin/cli/sessions.db`. See the note below for oh-my-pi. |
| `GROK_HOME` | `/data/grok` | `/data/grok/sessions/` |

These are the agents' own variables, so Agentboard follows a directory that you already moved. `PI_CODING_AGENT_DIR` takes precedence over `PI_CONFIG_DIR`, and `DEVIN_CLI_DIR` takes precedence over `XDG_DATA_HOME`.

A resume command is a template. Agentboard replaces `{sessionId}` with the agent's session ID and `{logFilePath}` with the transcript path. A template must contain one of the two placeholders, or **Wake** fails. Agentboard adds the flags that the session was first launched with.

Notes:

- oh-my-pi stores sessions in `$XDG_DATA_HOME/omp/sessions` when `$XDG_DATA_HOME/omp` exists and `PI_CODING_AGENT_DIR` is unset.
- Devin CLI keeps history in a SQLite database. Agentboard mirrors it into `devin-sessions/` in the data directory.

## Session matching

Agentboard matches each agent transcript to the tmux window that runs it. The match drives the last prompt, pull requests, and media shown for a session.

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_LOG_WATCH_MODE` | `watch` | `watch` or `poll`. How Agentboard detects transcript changes. |
| `AGENTBOARD_SKIP_MATCHING_PATTERNS` | see below | Sessions that skip window matching. |
| `AGENTBOARD_OWNERSHIP_MATCHING` | on (macOS) | Set `false` to turn off process-ownership matching. |
| `AGENTBOARD_OWNERSHIP_OBSERVER` | off | Set `true` for read-only ownership diagnostics. |

**`AGENTBOARD_LOG_WATCH_MODE`.** `watch` uses `fs.watch` and picks up a change within a few seconds. `poll` scans the transcript directories periodically. Use `poll` if you have problems with filesystem notifications, for example on a network-mounted home directory. Watch mode also runs a fallback scan: every 15 seconds on Linux, where `fs.watch({ recursive: true })` has known platform bugs, and every 60 seconds elsewhere. The fallback is slower if `AGENTBOARD_LOG_POLL_MS` is larger than those values.

**`AGENTBOARD_SKIP_MATCHING_PATTERNS`.** Comma-separated patterns, matched against the project path without regard to case, for orphan sessions that skip the expensive window matching. Defaults: `<codex-exec>` (headless Codex exec sessions), `/private/tmp/*`, `/private/var/folders/*`, `/var/folders/*`, `/tmp/*`. A trailing `*` matches a prefix; without it, the pattern must equal the path. Set an empty string to disable skipping.

### Ownership matching

Ownership matching identifies the conversation in a tmux window from the agent process that runs there. It covers local Claude Code and Codex sessions. The other agents keep the matching that is described above.

It is on by default on macOS. To turn it off, set `AGENTBOARD_OWNERSHIP_MATCHING=false` and restart Agentboard. Sessions that are already matched stay matched. On Linux the variable has no effect, because ownership matching is not yet validated there. You do not need to change any agent configuration.

How it identifies a conversation:

- **Claude Code.** It reads the session ID from Claude's local PID registry and checks the entry against the running process.
- **Codex.** It finds the one Codex process in the pane, then the transcript that this process holds open for writing, together with the writer lock for that conversation.

Both readers use internal file formats of the agents.

When ownership is confirmed:

- It takes precedence over scrollback, name, and slug matching.
- It can match a session that is idle.
- It can move a window to a different known conversation in one step.
- It never takes a conversation from another window.
- It never changes a session that has a stop or a wake in progress.

When ownership is not confirmed, the existing match stays. This is the result for a Codex session that a shared daemon serves, for a pane with more than one candidate, for a registry format that Agentboard does not recognize, and for an inspection that fails.

Ownership matching can bind only a conversation that is already in the Agentboard database. A Codex transcript that is not yet there is queued for discovery. A Claude transcript arrives through normal transcript discovery. A later ownership check then binds the conversation. Checks run at startup and every 30 seconds.

**Diagnostics.** `AGENTBOARD_OWNERSHIP_OBSERVER=true` turns on the observer: a read-only check of the same evidence for local Claude and Codex sessions, at startup and every 30 seconds. The observer also runs whenever ownership matching is on. To observe on macOS without ownership matching, set `AGENTBOARD_OWNERSHIP_MATCHING=false` as well. A changed result appears in the log as an `ownership_observation` event with the comparison `agree`, `unmatched`, `disagree`, or `unresolved`. Set `LOG_LEVEL=debug` to add the counts and the duration of each cycle.

To compare a running instance once from a source checkout, give the command the instance's tmux socket and API address:

```bash
bun scripts/observe-session-ownership.ts --socket /private/tmp/tmux-501/default --api http://127.0.0.1:4040
```

Replace the socket path with the tmux socket of the instance. The command reads process metadata and session headers. It sends no terminal input and makes no API writes. Use `--claude-home` or `--codex-home` for agent directories that are not in the default location. The observer needs `ps`, `tmux`, and, for Codex, `lsof`.

## Paste and uploads

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_PASTE_IMAGE_MAX_BYTES` | `41943040` (40 MiB) | Size limit for image uploads. |

Paste text or files directly into the terminal prompt. Desktop clipboard paste and file drops upload device files and insert their paths without pressing Enter. On mobile, **Paste** opens a dialog with a text field and a **Choose files** control.

The browser accepts files of any extension, up to 40 MiB (41,943,040 bytes) for each file. That limit is fixed. The browser sends PNG, JPEG, GIF, and WebP files to the image endpoint (`POST /api/paste-image`), which also applies `AGENTBOARD_PASTE_IMAGE_MAX_BYTES`. A value below 40 MiB lowers the limit for images. A value above 40 MiB has no effect in the browser, because the fixed limit applies first. The browser sends every other file to the general endpoint (`POST /api/paste-file`), which applies only the fixed limit. Files are stored temporarily on the Agentboard host. Uploads are unavailable for SSH sessions.

The mobile dialog works the same over HTTP and HTTPS. Type or paste into the field, or attach files with **Choose files**, then tap **Submit**. Agentboard inserts the text and the file paths into the existing terminal prompt without pressing Enter. Automatic clipboard reads elsewhere depend on browser support and permission and require HTTPS or localhost.

## Remote hosts

`AGENTBOARD_REMOTE_HOSTS` and the related `AGENTBOARD_REMOTE_*` variables are described in [remote-hosts.md](remote-hosts.md).

## Data and logging

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_DATA_DIR` | `~/.agentboard` | Base directory for all persistent data. |
| `AGENTBOARD_DB_PATH` | `<data dir>/agentboard.db` | Path of the session database. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `LOG_FILE` | `<data dir>/agentboard.log` | Path of the log file. |
| `AGENTBOARD_TMUX_PID_FILE` | `<data dir>/tmux-server.pid` | Where Agentboard records the tmux server PID. |

**Data directory.** The data directory holds the session database, the media index, the single-instance lock, the log file, and the recorded tmux server PID. Depending on your setup it also holds `devin-sessions/` (the Devin CLI mirror) and `stall-samples/` (macOS diagnostics). Set `AGENTBOARD_DATA_DIR` to move all of it. Use an absolute path: Agentboard does not expand `~` in this variable or in `AGENTBOARD_TMUX_PID_FILE`. It does expand a leading `~/` in `AGENTBOARD_DB_PATH` and `LOG_FILE`. Run one server per data directory.

`AGENTBOARD_DB_PATH` and `LOG_FILE` override individual paths. If you set `AGENTBOARD_DB_PATH`, the database stays at that path even when you change `AGENTBOARD_DATA_DIR`.

**Logging.** Installed releases (Homebrew, npm) write JSON to both the console and the log file. A source checkout pretty-prints the console. File output is always JSON.

A source checkout started with `bun run start` writes the log file only when `NODE_ENV=production` or `LOG_FILE` is set. The systemd and launchd installers set `NODE_ENV=production`. `bun run dev` sets `LOG_FILE` to the default path for you.

Set `LOG_FILE=` (empty) to disable file logging. This does not apply to `bun run dev`, which replaces an empty value with the default path.

Agentboard does not rotate the log file. The launchd installer adds an hourly job that rotates log files larger than 50 MB; see [launchd/README.md](../launchd/README.md).

## Tuning and diagnostics

The defaults suit most installations. Change these only to investigate a problem.

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENTBOARD_LOG_POLL_MS` | `5000` | Poll interval in `poll` mode (minimum `2000`), and the base for the fallback scan in `watch` mode. `0` turns off all transcript change detection, in both modes. |
| `AGENTBOARD_LOG_POLL_MAX` | `25` | Maximum transcripts processed per poll. The polls that fill in missing last prompts after startup process up to 100, or this value if it is larger. |
| `AGENTBOARD_RG_THREADS` | `1` | Threads for each ripgrep search. |
| `AGENTBOARD_LOG_MATCH_WORKER` | on | Set `0` or `false` to turn off the transcript-matching worker. Matching then does not run at all: each cycle is skipped, and the log shows `log_match_worker_disabled` once. |
| `AGENTBOARD_LOG_MATCH_PROFILE` | off | Logs matcher timing. |
| `AGENTBOARD_ENTER_REFRESH_MS` | `1000` | Delay between Enter in a terminal and the next status refresh. |
| `AGENTBOARD_WORKING_GRACE_MS` | `4000` | How long a session stays *working* after its output stops changing. |
| `AGENTBOARD_TMUX_TIMEOUT_MS` | `3000` | Timeout for tmux read commands. |
| `AGENTBOARD_TMUX_MUTATION_TIMEOUT_MS` | 5 × read timeout, minimum `15000` | Timeout for tmux commands that change state. A value below the read timeout is raised to it. |
| `AGENTBOARD_PERSISTENCE_MAINTENANCE_MS` | `5000` | Interval for session-recovery maintenance. `0` disables it. |
| `AGENTBOARD_STALL_WATCHDOG` | on (macOS) | Set `0` or `false` to turn off event-loop stall sampling, or `1` or `true` to force it on. |
| `AGENTBOARD_STALL_WATCHDOG_MS` | `2000` | Stall threshold. A value below `1000` is ignored. |
| `AGENTBOARD_TERMINAL_RELAY` | on | Set `0` to serve terminals from the main process instead of the relay worker. Only `0` turns it off. The relay serves at most 32 terminal connections at a time, including ones that are still closing. A connection over that limit gets "Terminal capacity reached". The limit is fixed. |
| `AGENTBOARD_RELAY_GRACE_MS` | `60000` | How long the relay keeps a disconnected terminal observer before it expires. |
| `AGENTBOARD_RELAY_PROGRESS_MS` | `90000` | How long a terminal lease lasts without client traffic. |
| `AGENTBOARD_ATTACH_DEDUP_MS` | `500` | Applies only with `AGENTBOARD_TERMINAL_RELAY=0`. A second attach to the same session and target inside this window is acknowledged without a new scrollback capture. The variable exists so that tests can widen the window. |
| `AGENTBOARD_STATIC_DIR` | `./dist/client` | Directory of the built frontend, relative to the working directory. The npm launcher and the launchd release installer set it. |

## Development

| Variable | Default | Effect |
| --- | --- | --- |
| `VITE_ALLOWED_HOSTS` | unset | Comma-separated hostnames allowed to reach the Vite dev server. |

`VITE_ALLOWED_HOSTS` is useful with Tailscale MagicDNS. Add your machine name (for example `nuc`) to open the dev server at `http://nuc:5173` from other devices on your tailnet. See [development.md](development.md).
