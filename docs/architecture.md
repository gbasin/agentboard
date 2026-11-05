# Architecture

This page maps the Agentboard server and client as the code stands. Read it before you change the server. File paths are the anchors: when this page and the code disagree, the code is right and this page needs a fix in the same pull request.

User-facing behaviour and every environment variable are in [configuration.md](configuration.md). This page names a variable only where it explains a mechanism.

## Contents

- [Repository layout](#repository-layout)
- [Processes and threads](#processes-and-threads)
  - [Listeners](#listeners)
  - [Workers](#workers)
  - [Worker rules](#worker-rules)
  - [Startup and shutdown](#startup-and-shutdown)
- [The tmux model](#the-tmux-model)
  - [Managed session and bootstrap window](#managed-session-and-bootstrap-window)
  - [Discovered sessions](#discovered-sessions)
  - [Grouped sessions](#grouped-sessions)
  - [Nested-tmux guard and subprocess environment](#nested-tmux-guard-and-subprocess-environment)
  - [Timeouts and kills](#timeouts-and-kills)
- [Terminal I/O](#terminal-io)
  - [Proxy modes](#proxy-modes)
  - [Relay leases](#relay-leases)
  - [Sizing, paste, clipboard and copy mode](#sizing-paste-clipboard-and-copy-mode)
- [Status inference](#status-inference)
- [Log pipeline](#log-pipeline)
  - [Transcript roots](#transcript-roots)
  - [Change detection](#change-detection)
  - [Matching a transcript to a window](#matching-a-transcript-to-a-window)
  - [Startup verification](#startup-verification)
  - [Devin mirror](#devin-mirror)
- [Enrichment](#enrichment)
  - [Pull requests](#pull-requests)
  - [Media](#media)
  - [Subagent activity](#subagent-activity)
- [Storage](#storage)
  - [Data directory](#data-directory)
  - [Main database](#main-database)
  - [Session-recovery catalog](#session-recovery-catalog)
  - [Media index](#media-index)
- [HTTP and WebSocket surface](#http-and-websocket-surface)
- [Client](#client)
- [When you add X, also change Y](#when-you-add-x-also-change-y)

## Repository layout

| Path | Contents |
| --- | --- |
| `src/server/` | Bun backend: Hono routes, WebSocket handling, tmux, terminal proxies, log parsing, workers. Entry point `src/server/index.ts`. |
| `src/server/relay/` | Public terminal listener and per-terminal workers. |
| `src/server/terminal/` | Terminal proxies: `PtyTerminalProxy`, `PipePaneTerminalProxy`, `SshTerminalProxy`. |
| `src/server/persistence/` | Session-recovery catalog. |
| `src/server/ownership/` | Process-ownership matching for Claude and Codex. |
| `src/client/` | React app built by Vite into `dist/client`. Entry point `src/client/main.tsx`. |
| `src/shared/` | Types and protocol constants shared by both sides (`types.ts`, `catalogProtocol.ts`, `media.ts`, `syncedSettings.ts`). |
| `scripts/` | Test runner, dev server, dependency scanner, compiled-binary checks. |
| `tests/e2e/` | Playwright suites. |

The server runs from source with `bun`, or as a binary built by `bun build --compile` in `.github/workflows/release.yml`. Vite never bundles the server.

## Processes and threads

One Bun process runs everything. The main thread owns the read-write database, the tmux refresh loop, the log poller, and all HTTP routes. Slow or blocking work runs in Workers.

### Listeners

| Listener | Where | Binds |
| --- | --- | --- |
| Dashboard | `Bun.serve` in `src/server/index.ts` | With the relay on: `127.0.0.1`, an ephemeral port, no TLS. With the relay off: `HOSTNAME`:`PORT` with TLS. |
| Public relay | `Bun.serve` in `src/server/terminalRelayWorker.ts` | `HOSTNAME`:`PORT` (default `127.0.0.1:4040`), with TLS when `TLS_CERT` and `TLS_KEY` are both set. |
| Tailscale | `tailscaleReady` in `src/server/index.ts` | The Tailscale IPv4 address on `PORT`, only when `HOSTNAME` is `127.0.0.1`. The relay worker opens it with a `bind` message; with the relay off, the main thread opens a second `Bun.serve`. With `HOSTNAME=0.0.0.0` the address is only logged. |

The relay is on unless `AGENTBOARD_TERMINAL_RELAY=0`, or `NODE_ENV=test` without the variable (`relayEnabled` in `src/server/index.ts`).

With the relay on, browsers reach only the relay listener. It upgrades `/ws` itself. It proxies every other request to the loopback dashboard listener, and answers 503 when that fails. On the WebSocket it handles `ping` and every terminal message (`TERMINAL_TYPES` in `src/server/relay/leases.ts`). It forwards all other messages to the main thread, where `relayMessage` (`src/server/index.ts`) wraps each relay socket in a stand-in `ServerWebSocket` and runs the normal handlers. Terminal output therefore never passes through the main event loop. Pongs still share one browser socket with catalog traffic, so a large catalog frame on a slow link delays a pong.

The `HOSTNAME` that a container exports automatically (equal to `os.hostname()`) is ignored (`resolveBindHostname` in `src/server/config.ts`).

### Workers

Every worker entry file is `src/server/*Worker.ts`. Clients resolve its path with `resolveWorkerPath` (`src/server/workerPath.ts`).

| Worker | Spawned by | Job | Own SQLite | Spawns processes |
| --- | --- | --- | --- | --- |
| `terminalRelayWorker` | `TerminalRelayClient` (`relay/client.ts`) | Public listener, lease table | no | no |
| `terminalSessionWorker` | `TerminalLeases.startWorker` (`relay/leases.ts`), one per terminal lease, `smol` | One terminal: tmux client PTY or SSH, paste, clipboard poll | no | yes |
| `sessionRefreshWorker` | `SessionRefreshWorkerClient`, two instances (refresh and last-user-message) | `list-windows`, `capture-pane`, status inference | no | yes (tmux) |
| `logMatchWorker` | `LogPoller`; `startupVerify.ts` | Transcript scans, `rg` matching, pane captures, Codex subagent index | no | yes (`rg`, tmux) |
| `devinSyncWorker` | `LogPoller` | Devin SQLite mirror | yes, read-only on Devin's `sessions.db` | no |
| `sessionReadWorker` | `SessionReadClient` (file databases only) | Poll snapshots, known-session keys, import candidates | yes, read-only on `agentboard.db` | no |
| `sessionMetadataWorker` | `SessionMetadataClient` | PR extraction from transcripts | no | no |
| `sessionActivityWorker` | `SessionActivityClient` | Subagent activity scan | no | no |
| `mediaDiscoveryWriterWorker` | `MediaDiscoveryClient` via `DiscoveryRpc` | Media index scans | yes, `media-index.sqlite` read-write | no |
| `mediaDiscoveryReaderWorker` | same | Media pages and neighbors; never scans files | yes, `media-index.sqlite` read-only | no |
| `mediaThumbnailWorker` | `MediaThumbnailClient` | PNG/JPEG thumbnail decode | no | no |
| `stallWatchdogWorker` | `StallWatchdog` | Samples the main thread during a stall | no | yes (`sample`) |

Message types for each boundary live next to the worker: `relay/protocol.ts`, `logMatchWorkerTypes.ts`, `mediaDiscoveryProtocol.ts`, `sessionActivityProtocol.ts`, `mediaThumbnailTypes.ts`, and the request/response types at the top of each other worker file. Only `{id, tmuxWindow, host, remote}` per session crosses into the relay and terminal workers (`TerminalSession` in `relay/protocol.ts`). `TerminalRelayClient.post` drops a `sessions` update whose sorted list and colour flag are unchanged, so status and transcript churn causes no relay traffic.

Failure handling differs per worker:

- The relay worker and the per-lease workers are fatal on `onerror`: the main thread logs and exits 1.
- `sessionRefreshWorker` and `logMatchWorker` have per-request timeouts. On a timeout the client fails pending requests and starts a new worker.
- `sessionMetadataWorker` and `sessionActivityWorker` retry after failure with backoff.
- The media discovery RPC keeps a timed-out request's slot until the worker replies. New requests fail meanwhile. A worker is replaced only after a confirmed `close`, because native work may still be running (`mediaDiscoveryRpc.ts`).
- A `mediaThumbnailWorker` error disables thumbnails until restart.
- `devinSyncWorker` and `sessionReadWorker` only log slow requests. A second Devin worker would append the same rows and race on the temporary file (`devinSyncWorkerClient.ts`).

### Worker rules

- Do not call `worker.terminate()`. It segfaults compiled Bun binaries (BUN-118B; comments in `logMatchWorkerClient.ts`, `sessionRefreshWorkerClient.ts`, `stallWatchdog.ts`, `sessionReadClient.ts`, `mediaThumbnailClient.ts`). Clients post a `shutdown` message and the worker closes itself.
- Workers handle `shutdown` synchronously inside `onmessage` and call `self.close()` there (for example `mediaThumbnailWorker.ts`). Follow the same pattern in a new worker.
- Never close a PTY worker realm during normal service. Closing a nested Bun PTY realm SIGTRAPs the process on Bun 1.3.14 for macOS. `TerminalLeases` reuses a worker only after it acknowledges disposal with `stopped`, and process exit owns the realms at shutdown (`relay/leases.ts`, `terminalRelayWorker.ts`).
- On macOS, PTY creation is serialised across terminal workers by an Atomics lock on a shared 4-byte buffer (`relay/ptySpawnLock.ts`). Concurrent `Bun.spawn({ terminal })` calls can leave the main thread's signals blocked, so SIGTERM and SIGINT stop working while HTTP still answers. The lock covers only the synchronous spawn call, applies only on darwin with a terminal, and refuses to run on the main thread. A waiter gives up after 5 s.
- Workers keep the process-start environment. Pass `env` explicitly: `workerEnvironment()` (`relay/protocol.ts`) or `sanitizedTmuxEnv()` (`tmuxEnv.ts`).
- These Bun constraints are tied to the pinned Bun version (`.bun-version`). Re-test them when you upgrade Bun.

### Startup and shutdown

`src/server/index.ts` runs its startup as top-level module code, in this order:

1. Nested-tmux guard (`decideNestedTmux`, `src/server/tmuxIsolation.ts`). It runs before any tmux spawn.
2. Port check with `lsof`; exit 1 if the port is taken.
3. Single-instance lock `<dataDir>/server.lock` (`src/server/instanceLock.ts`); exit 1 if held.
4. `tmux -V` (`src/server/prerequisites.ts`) and terminal-mode resolution.
5. `initDatabase({ exclusive: true })`, which takes the database ownership lock. Then settings from `app_settings`, `SessionManager`, and a synchronous `ensureSession()` for the managed session.
6. Clients, the log poller, the refresh interval (`REFRESH_INTERVAL_MS`, default 2000 ms), the event-loop lag monitor (500 ms tick), and the stall watchdog.
7. The dashboard listener, then the relay, then the `server_started` log line, then the Tailscale lookup. The Tailscale lookup (`tailscale ip -4`, 5 s timeout, `src/server/tailscale.ts`) runs after the listener is up, so a slow `tailscaled` never delays startup.
8. The startup sequence (`startupReady`): an async refresh, the ownership observer, `logPoller.start()`, `startupHousekeeping()` (scrub leaked tmux environment variables, prune orphaned grouped sessions), then startup verification. The poller starts only after the first refresh, because its first snapshot would race the worker spawns of boot.

SIGINT and SIGTERM run `cleanupAllTerminals()` and exit 0. It shuts the relay down first (6 s deadline), then stops timers and workers, then closes the database. The `exit` handler releases `server.lock`.

## The tmux model

### Managed session and bootstrap window

Agentboard owns one tmux session, `TMUX_SESSION` (default `agentboard`). Each agent session is a window in it. `SessionManager.createWindow` names new windows from the request or `generateSessionName()` (`adjective-noun`, `src/server/nameGenerator.ts`). Names are validated by `src/server/windowName.ts`: at most 120 characters, no control characters, no `\` (tmux format output escapes it, so the name could not round-trip). Windows are always addressed by window ID (`<session>:@<id>`), never by name. A live session's `id` is that tmux target.

tmux needs at least one window per session, so `ensureSession` creates the managed session with a bootstrap window `__agentboard_root__` running `tail -f /dev/null` (`src/server/tmuxFormat.ts`). That name is reserved: it is hidden in every session, and create and rename refuse it.

`ensureSession` probes with `display-message -p -t =<name>:`. The `=name:` form matters twice over: a bare `=name` parses as a pane target, and without the exact match a grouped `<name>-ws-*` session would satisfy the probe and the base would never be created. When tmux is unreachable, `ensureSession` signals the recorded tmux server PID (`tmux-server.pid`) with SIGUSR1 to recreate its socket, at most once per 30 s, and refuses to start a replacement server. If a grouped session survives without its base, the base is recreated as a member of that group.

All tmux format calls use tab-separated fields and `tmux -u`, which keeps tabs intact under minimal locales (`tmuxFormat.ts`). `escapeTmuxFormatArg` doubles `#` because tmux format-expands window-name arguments.

### Discovered sessions

Windows in every other tmux session appear as discovered (external) sessions. `DISCOVER_PREFIXES` narrows that to sessions whose names start with a listed prefix. `<base>-ws-*` sessions are never discovered. The refresh worker also drops any discovered window whose window ID belongs to the managed session (`sessionRefreshWorker.ts`): grouped and linked sessions would otherwise duplicate managed windows, and killing a duplicate kills the real window. Killing discovered sessions needs `ALLOW_KILL_EXTERNAL=true`.

Remote hosts (`src/server/remoteSessions.ts`) are polled over SSH with one `tmux list-windows -a` and one batched capture per host. Their session IDs are `remote:<host>:<session>:<@id>`.

### Grouped sessions

A browser terminal never attaches to the managed session directly. `PtyTerminalProxy` creates a per-terminal session grouped with it, named `<TMUX_SESSION>-ws-<id>` (`createGroupedSession`, `src/server/tmuxGroupedSession.ts`). With the relay, `<id>` is the terminal lease ID; without it, the WebSocket connection ID. A dashboard-only tab has no lease worker and no grouped session. The grouped session has its own current-window pointer, so browsers switch windows without moving each other or your own tmux clients. The proxy copies `mouse` from the base, sets `allow-passthrough on`, and turns `status off` (the hidden status bar cost about 30% of tmux server CPU in redraws).

To view a discovered session, the proxy creates a mirror grouped with it, `<ws-session>-x-<sanitized>-<hash>`. It checks `has-session =<raw>` first, because `new-session -t` with an unknown name silently starts an unrelated group. It validates membership by window, not by group name, because group names survive a kill and recreate.

Each `new-session -t` spawns and immediately destroys a login shell. On macOS a shell that loses its PTY before it gets a controlling terminal can block forever. `ThrowawayShellReaper` (`src/server/throwawayShellReaper.ts`) finds such shells (direct child of the tmux server, not a pane, dashed argv0, at least 60 s old, no children, only file descriptors 0–2) and sends SIGHUP, then SIGKILL. It runs only on macOS. Grouped-session creation only re-arms its timer: do not add process listing or any other spawn to `createGroupedSession`, because synchronous `ps` there once froze the server.

Grouped sessions are killed on dispose and switch-away. At startup, `startupHousekeeping` kills unattached `<base>-ws-*` sessions that no live socket or lease owns (`PRUNE_WS_SESSIONS`, `src/server/startupVerify.ts`).

### Nested-tmux guard and subprocess environment

An agent inside an Agentboard pane inherits `$TMUX`. A server started there would join the live tmux server and see live windows as discovered duplicates. `decideNestedTmux` (`src/server/tmuxIsolation.ts`) decides at startup:

1. No `$TMUX`: proceed.
2. `TMUX_TMPDIR` set: isolate. Delete `TMUX` and `TMUX_PANE` from `process.env` and create the directory (tmux ignores a missing `TMUX_TMPDIR` and falls back to the default socket).
3. `AGENTBOARD_ALLOW_NESTED_TMUX=true`: proceed on the shared server.
4. Otherwise refuse when the pane's session holds `__agentboard_root__`. A failed probe counts as managed.

`Bun.spawn`/`spawnSync` without `env`, and every Worker, use the process-start environment and miss step 2. Every subprocess therefore passes `env` explicitly. `sanitizedTmuxEnv()` (`src/server/tmuxEnv.ts`) removes `NODE_ENV`, `AGENTBOARD_STATIC_DIR`, and `npm_*`, which a tmux daemon would otherwise capture permanently for every later pane. It also removes `TMUX` and `TMUX_PANE` when `TMUX_TMPDIR` is set. It adds nothing. `timedSpawnSync` and `timedSpawnAsync` (`src/server/syncSpawnTiming.ts`) default to it and log spawns slower than 250 ms. `SshTerminalProxy` attaches with `process.env` plus `TERM`.

### Timeouts and kills

tmux reads time out after `AGENTBOARD_TMUX_TIMEOUT_MS` (3000 ms). Mutations (`new-session`, `new-window`, `kill-*`, `switch-client`, `rename-window`, `set-*`, and others) use the longer mutation timeout. A timeout raises `TmuxTimeoutError` (`src/server/tmuxTimeout.ts`).

`kill-window` on the last window of a grouped session crashes tmux 3.7b. For that case `src/server/tmuxKillGuard.ts` moves or detaches clients, kills the other group members, then kills the target session. It refuses on a timeout or an unparseable listing. Kills from one connection are rate-limited to 3 per 5 s (`src/server/killRateLimit.ts`).

## Terminal I/O

### Proxy modes

`TERMINAL_MODE` selects the local proxy (`resolveTerminalMode`, `src/server/terminal/TerminalProxyFactory.ts`). `auto` picks `pty` when stdin is a TTY and `pipe-pane` otherwise. Remote sessions always use `SshTerminalProxy`.

- **`pty`** (`PtyTerminalProxy.ts`, default). Creates the grouped session, spawns `tmux -u [-T sync] attach [-f ignore-size] -t <ws-session>` in a Bun PTY, finds the client TTY in `list-clients`, and switches windows with `switch-client -c <tty>`, verifying the result. `-T sync` makes tmux wrap redraws in DEC 2026 synchronized-update markers. `-T sync` and `-f ignore-size` need tmux 3.2 and are gated on the running server's `#{version}`, not the client binary.
- **`pipe-pane`** (`PipePaneTerminalProxy.ts`). No tmux client and no grouped session. Output comes from `pipe-pane` into a file under `$TMPDIR/agentboard-pipes/` read by `tail -F`. Input goes through `send-keys -l`. Wheel events become copy-mode scroll commands. It cannot opt out of pane sizing.
- **SSH** (`SshTerminalProxy.ts`). Creates a standalone `<base>-ws-<id>` session on the remote host and attaches with `ssh -tt`. Commands use `-o ControlMaster=no` to avoid hangs on stale control sockets.

### Relay leases

With the relay on, `TerminalLeases` (`src/server/relay/leases.ts`) owns browser terminals. A lease is one browser document's terminal state: a worker, an owning socket, an epoch, and a claim counter. A lease observes an agent pane; it never owns one, so disposing a lease never kills an agent window.

- The client sends `terminal-resume {token, claim}` after the catalog handshake. A new token creates a retained lease and the server answers `terminal-lease`. A known token with a higher claim moves the lease to the new socket, bumps the epoch, and closes the old socket with 4001. A claim that is not newer is rejected with 1008. The client keeps the token in memory only, so a duplicated tab cannot take over the original's lease.
- The lease's `terminalSessionWorker` starts only on the first valid `terminal-attach`. Dashboard-only tabs cost no worker.
- A lease with an owner but no client progress for 90 s is closed with 4001 (`AGENTBOARD_RELAY_PROGRESS_MS`). This covers a phone that suspends without closing its socket. A detached lease is retired after 60 s (`AGENTBOARD_RELAY_GRACE_MS`).
- At most 32 leases, including retiring ones, exist at a time. Idle leases count. When full, the oldest ownerless lease is retired; if none is ownerless, the new socket is overloaded.
- Retiring posts `shutdown` and waits for `stopped`. After 5 s it only logs `terminal_worker_disposal_delayed`. The realm stays counted and is not reused, so one stuck tmux cleanup costs one slot instead of the service.
- Output budgets are tiered: 1 MiB of unacknowledged output per retained client (the client acks with `terminal-ack` after its parser finishes), 2 MiB from worker to relay awaiting credit, and 16 MiB of payload plus Bun's send buffer per socket. Any overflow sends `terminal-overload` and closes with 1013; ANSI output is never dropped mid-stream. WebKit can report the 1013 close as 1005, so the frame comes first.
- When the worker reports Enter in local input, the relay posts `submit` to the main thread, which applies the post-Enter status override (see [Status inference](#status-inference)).

`TerminalRuntime` (`relay/terminalRuntime.ts`) runs inside each lease worker. It validates the attach, captures the screen (`capture-pane -p -J`), switches the tmux client, sends history in 12,000-character chunks, and re-checks session identity after each async step. Without the relay, the same work runs on the main thread in `src/server/index.ts`.

### Sizing, paste, clipboard and copy mode

- **Sizing.** Relay proxies start excluded from window sizing (`-f ignore-size`). A verified foreground attach opts in with `refresh-client -f !ignore-size`, and suspend opts out again. Changes are serialised per proxy (`TerminalProxyBase.setSizeParticipation`). Without this, a retained background phone would hold a desktop pane at phone width.
- **Paste.** `terminal-paste` goes through `load-buffer` (stdin, avoiding the argv size limit) and `paste-buffer -d -p` (`deliverPasteViaTmux`, `TerminalProxyBase.ts`). `-p` brackets the paste only when the pane's application enabled bracketed paste, so multi-line text is not submitted line by line. There is no fallback to raw writes. `paste-buffer -t` takes a pane target, which rejects the `=name` form, so the target is a bare session name. Paste never counts as a submit.
- **Uploads.** `/api/paste-file` streams the multipart body itself (Bun's `formData()` is unreliable) into `$TMPDIR/agentboard-upload-*`, mode 0600, limit 40 MiB. The client then pastes the quoted path. `/api/paste-image` writes `/tmp/paste-*`. Uploads are disabled for SSH sessions.
- **Clipboard.** The `pty` proxy sets tmux `set-clipboard on` (server-global) unless `AGENTBOARD_TMUX_SET_CLIPBOARD` disables it. A left-button press arms a 5 s window; the terminal polls `list-buffers` every 750 ms and offers a new buffer of at most 512 KiB to the browser as `clipboard-offer`. This path exists because iOS Safari's async OSC 52 path cannot satisfy the user-gesture rule. It never runs for remote sessions.
- **Copy mode.** `tmux-check-copy-mode` reads `#{pane_in_mode},#{alternate_on},#{mouse_any_flag}` asynchronously; a synchronous read on the dashboard loop once blocked every terminal. `CopyModeQuery` (`src/server/copyModeQuery.ts`) drops a result only when a newer completed read was already published, so latency above the poll interval cannot starve the UI. Input and paste queue behind a pending `tmux-cancel-copy-mode`.

## Status inference

A session's status is `working`, `waiting`, `permission`, or `unknown` (`SessionStatus`, `src/shared/types.ts`). It comes from pane content only. Logs do not change it.

Every refresh captures the visible pane (`capture-pane -p -J`, trailing blank lines dropped, last 30 lines kept) with its width and height, in `sessionRefreshWorker.ts`, the synchronous `SessionManager` fallback, or `remoteSessions.ts`. `inferSessionStatus` (`src/server/statusInference.ts`) is a pure function, evaluated in order:

1. First observation with no permission prompt: `waiting`.
2. Content changed: `working`. Working wins over a permission prompt. After a resize, "changed" means token overlap below 90% of the normalised content (ANSI, decorative lines, timers and UI glyphs stripped), so a reflow does not count.
3. A permission prompt in the last 10 non-blank lines (`PERMISSION_PATTERNS`, covering Claude Code, Codex, Devin, and generic `[y/n]` prompts): `permission`.
4. Content changed within the working grace period (`AGENTBOARD_WORKING_GRACE_MS`, 4000 ms): `working`. This absorbs an agent's short pauses.
5. Otherwise `waiting`.

When a capture fails, `inferCachedSessionStatus` re-evaluates the cached content; with no cache the status is `unknown`.

**Post-Enter override.** Input containing `\r` or `\n` to a local session calls `setForceWorking` (`src/server/index.ts`). It sets the status to `working` at once and holds it there for the grace period (`src/server/forceWorkingStatus.ts`), so the status does not flicker before the agent prints anything. It also schedules one refresh and a capture of the last user prompt after `AGENTBOARD_ENTER_REFRESH_MS` (1000 ms). The prompt capture locks the window's last-message field for 60 s, so the log poller does not overwrite it with an older value. A capture that returns a collapsed paste placeholder releases the lock and lets the transcript supply the prompt. The override applies on the refresh-worker path and in startup verification, not in the synchronous refresh that follows a mutation.

Subagent activity (see [Subagent activity](#subagent-activity)) is a separate field and does not change status.

## Log pipeline

Transcripts drive four things: which conversation a window runs, the last user prompt, PR chips, and media. Status does not come from them.

### Transcript roots

`src/server/logDiscovery.ts` owns the roots:

| Agent | Root | Scan depth |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`) | 3 |
| Codex | `$CODEX_HOME/sessions` (default `~/.codex/sessions`) | 4 |
| Pi | `$PI_HOME/agent/sessions` (default `~/.pi/agent/sessions`) | 4 |
| oh-my-pi | `$PI_CODING_AGENT_DIR/sessions`, or `~/<PI_CONFIG_DIR or .omp>/agent/sessions`, or `$XDG_DATA_HOME/omp/sessions` when that exists and no agent dir is set | 4 |
| Grok CLI | `$GROK_HOME/sessions` (default `~/.grok/sessions`), only `chat_history.jsonl` | 3 |
| Devin CLI | the mirror `<dataDir>/devin-sessions` (see [Devin mirror](#devin-mirror)) | 2 |

Scans skip symlinks and `subagents` directories. Agent type comes from the root a file is under; oh-my-pi is checked before Pi because its directory can sit under `.pi`. Grok's session ID and project path come from the directory names. File heads are read 64 KiB at a time, growing to 1 MiB when the last line is cut.

### Change detection

`AGENTBOARD_LOG_WATCH_MODE` selects `watch` (default) or `poll` (`src/server/logPoller.ts`).

- **Watch.** `LogWatcher` (`src/server/logWatcher.ts`) runs one `fs.watch(dir, { recursive: true })` per root, keeps `*.jsonl` events, and debounces them (2 s, forced flush at 5 s). A missing root is watched at its nearest existing ancestor, unless that ancestor is `$HOME` or `/`. A full reconciliation still runs every `max(AGENTBOARD_LOG_POLL_MS, 15 s)` on Linux and `max(…, 60 s)` elsewhere: on Linux, Bun's recursive watch misses files in newly created subdirectories (Bun #15939). Paths that arrive while a cycle runs are queued, at most `AGENTBOARD_LOG_POLL_MAX` per cycle.
- **Poll.** A full cycle every `max(2000, AGENTBOARD_LOG_POLL_MS)` ms.

A full cycle (`pollOnce`) reads a snapshot through `sessionReadWorker`, then asks `logMatchWorker` to scan. Without explicit paths, the worker stats every transcript, keeps the newest `AGENTBOARD_LOG_POLL_MAX` (default 25) by mtime, and reads content only for transcripts not yet in the database. Snapshots load at most 72 hours of history rows and trim messages to 2048 characters, because full rows made every worker message clone very large. Last-prompt reads scan backward from the end of the file in a growing window (32 KiB up to 2 MiB) with no line limit, because a long agent run pushes the last user line far from the end. A session's activity time is the last entry's timestamp when the file grew; mtime alone moves on backups and syncs.

### Matching a transcript to a window

`agent_sessions.current_window` records which window runs a conversation. A partial unique index allows one row per window, and `claimCurrentWindow` is a compare-and-set that succeeds only when the row is unclaimed and no other row holds the window (`src/server/db.ts`). The poller never steals a claimed window. Strategies, in precedence order:

1. **Process ownership** (`src/server/ownership/`, macOS by default; `AGENTBOARD_OWNERSHIP_MATCHING`). Every 30 s the observer snapshots `tmux list-panes`, `ps`, and `lsof` before and after reading identity, and discards results that changed underneath it. Claude identity comes from `<claudeHome>/sessions/<pid>.json`, read twice and checked against the process start time. Codex identity needs exactly one outermost `codex` process, an open writable `rollout-*.jsonl` with `source` `cli`, and an open thread-writer lock; it never infers identity from cwd or recency. Accepted evidence switches the window to that conversation in one transaction, unless the conversation already owns another window, a stop or wake is pending, or the agent types differ. Inspection failures never release a claim. Evidence also vetoes content matches that disagree with it (`allowsMatch`).
2. **Devin lock PID** (`src/server/devinLockMatch.ts`). `session_locks/<id>.lock` holds a PID; the window whose pane PID is its ancestor (at most 64 levels) wins.
3. **Content matching** (`src/server/logMatcher.ts`). The worker captures each unclaimed window's scrollback (`capture-pane -J -S -10000`), extracts recent prompt lines (`❯` for Claude, `›` for Codex, a background colour for Pi, AskUserQuestion recaps, and trace lines as a last resort), and runs `rg -l` over the roots. Candidates must contain the prompt as real user input, not tool output. Then, in order: a hard agent-type gate (a Claude window never matches a Codex transcript; unknown types pass), a soft cwd gate (applied only when a candidate survives it), and scoring by ordered matches. A tie after a full re-score is no match. When two windows claim one transcript, the higher score wins and an equal score blocks the transcript for that pass. The agent-type gate exists because the same prompt pasted into a Claude and a Codex window seconds apart otherwise swaps them.
4. **Name fallback.** Only in the one-time orphan rematch after the first clean cycle: a unique, unclaimed, managed window whose name equals the session's display name.

A new Claude transcript whose slug and project match an existing session takes over that session's window and name, and the old session becomes an orphan (slug supersede). A new transcript is inserted only once it has content. Insertion waits while an unclaimed managed window in the same project, with a compatible agent, shows no prompts yet.

`shouldRunMatching` (`src/server/logMatchGate.ts`) limits who is retried: `codex exec` sessions never match; orphans are retried only when their transcript grew and their project path is outside `AGENTBOARD_SKIP_MATCHING_PATTERNS`; one session is re-matched at most once a minute.

### Startup verification

At startup every claimed window is re-verified (`src/server/startupVerify.ts`, `hydrateSessionsWithAgentSessions` in `src/server/index.ts`). Ownership evidence counts as verified. Other windows go to `logMatchWorker` as one batch (10-minute timeout); without the worker, verification runs inline two windows at a time, because verifying every window at once saturated disk and CPU. A link survives when content verifies or when the window name equals the session's display name. Window names are a deliberate user signal, and content matching can prefer another log when sessions look alike or scrollback is short. A verification that throws keeps the link; a worker timeout is inconclusive and the name decides. Anything else orphans the session.

When a claimed window is missing from a refresh, `probeWindow` asks tmux directly. Only a definite `absent` orphans the row; an unknown result keeps it with status `unknown`.

### Devin mirror

Devin CLI keeps history in SQLite (`$DEVIN_CLI_DIR` or `$XDG_DATA_HOME/devin/cli`, default `~/.local/share/devin/cli/sessions.db`). `devinSyncWorker` (`src/server/devinSync.ts`) mirrors visible sessions into `<dataDir>/devin-sessions/<id>.jsonl` in a Claude-shaped format, so the rest of the pipeline treats them like any transcript. It drops user rows that are not real user input (keepalive "continue" prompts, compaction requests).

It runs every `max(2000, AGENTBOARD_LOG_POLL_MS)` ms in both modes. Each cycle does the least work it can: if the database fingerprint is unchanged, the last full check is under 30 s old, and every mirror has its recorded size, it returns without opening SQLite. Otherwise it compares per-session row counts, appends new rows when the prefix is intact, and rewrites atomically (temp file plus rename) otherwise. The fingerprint (`src/server/devinDbFingerprint.ts`) includes the database header's change counter, the `-wal` header, and the `-shm` bytes, because a commit after a WAL reset can land inside the old WAL size within one mtime tick. An uncertain fingerprint counts as changed. `MIRROR_FORMAT_VERSION` forces a full rewrite when bumped.

## Enrichment

### Pull requests

`sessionMetadataWorker` extracts PRs from transcripts (`src/server/prExtractor.ts`), keyed by `(sessionId, logFilePath, agentType)` and retried with backoff from 1 s to 30 s (`src/server/sessionMetadataClient.ts`). It counts `gh pr create` only in command position of a real tool call, and attributes the URL through that call's tool result. It also reads Claude `pr-link` records. Scans are incremental by byte offset; a shrunk file, or a same-size file with a new mtime, is rescanned. A byte prefilter skips records that cannot match (`prCreatePrefilter.ts`).

PR state comes from `gh pr view` (`src/server/ghRequestQueue.ts`, `src/server/prInfo.ts`): at most 4 processes, 128 distinct outstanding requests (more resolve to `null`), duplicates share one promise, 8 s timeout with SIGKILL, and a slot is held until the process and both pipes settle. Results are cached 60 s, up to 5,000 entries. The browser batches 8 URLs per request and runs one info request and one checks request at a time, with a 20 s abort (`src/client/lib/prMetadataRequests.ts`). This keeps optional chips from filling the browser's HTTP/1 connection pool and stalling media fetches.

### Media

`src/server/mediaExtractor.ts` finds images and documents in transcripts (Claude `image`/`document` blocks, Codex `input_image`, image generation, links in assistant prose via `replyLinks.ts`). `mediaDiscoveryWriterWorker` indexes them into `media-index.sqlite`; `mediaDiscoveryReaderWorker` serves pages from a read-only connection, so reads never wait on scans (`src/server/mediaDiscovery.ts`).

- **Scans** are resumable per file. A checkpoint records inode, size, mtime, and a SHA-256 of the first and last 256 bytes before the offset. An interior rewrite that also grows the file is not detected there; per-record digests on payload routes catch it at read time and force a reindex. Each step commits up to 1 MiB with a 12 ms target and yields only at record boundaries. Records over 64 MiB and descriptors over 16 KiB are skipped and counted, not truncated. Order time is a running maximum within a file, so a backward timestamp cannot reorder records.
- **Scheduling.** At most 32 scanner jobs. A panel someone is viewing gets up to 4 slices before one background slice; unviewed dormant jobs are cancelled at their checkpoint.
- **Pages** hold at most 40 items and 64 KiB (`src/shared/media.ts`), newest first. A cursor carries an ID watermark and the session generation: rows indexed after the first page stay hidden until Refresh, and a rewrite bumps the generation so old cursors fail with `STALE_CURSOR`. Lightbox neighbors read the live index, not the watermark. The discovery stream is NDJSON with 64 KiB frames, 512 KiB and 60 s per stream; the client retries 3 times per open, then shows Retry.
- **Payloads** (`src/server/mediaRoutes.ts`) are served only from the session's own transcript or its subagent logs, checked against the record's digest. Digest URLs are cached `private, immutable`. Only raster images, PDF, and plain text render inline; everything else is an `octet-stream` attachment. Every response carries a sandbox CSP and `nosniff` (`mediaPayloadHeaders.ts`). External media URLs are redirected (302, `http:`/`https:` only); the server never fetches them.
- **Thumbnails** (`mediaThumbnailDecoder.ts`, `mediaThumbnails.ts`) use pure-JS `pngjs` and `jpeg-js`, so the four compiled release targets need no native codec libraries. Limits: source 16 MiB, 16 megapixels, 16,000 px per side, output 128 px long edge and 128 KiB. Interlaced PNG and APNG are rejected because pngjs's interlaced inflate has no output limit. One decode runs at a time with a 10 s deadline and 16 queued requests; the cache is a 16 MiB, 1,024-entry in-memory LRU. The client loads thumbnails near the viewport only, 3 at a time.

Catalog messages carry media counts (`mediaSummary`), never descriptor lists (`src/server/catalogMessages.ts`). Full lists made catalog frames large enough to starve heartbeats on slow links. The same module truncates `lastUserMessage` to 250 characters on the wire.

### Subagent activity

`sessionActivityWorker` (`src/server/sessionActivity.ts`, `activityReducer.ts`) tracks subagents for local managed Claude and Codex sessions. Claude subagents live in `<transcript stem>/subagents/agent-*.jsonl`; Codex subagents are linked through an ID-to-parent index that `logMatchWorker` rebuilds every 5 minutes (`src/server/subagentLogs.ts`, `codexSubagentScan.ts`). Reads are incremental (256 KiB) with bounded caches. A session with no lifecycle signal for 15 minutes reports `unknown`. The reducer sends only phases and counts, never prompts, arguments, reasoning, or tool output.

## Storage

### Data directory

`AGENTBOARD_DATA_DIR` (default `~/.agentboard`). `config.ts`, `db.ts`, and `devinSync.ts` each compute the default.

| Path | Owner |
| --- | --- |
| `agentboard.db`, `-wal`, `-shm` | `src/server/db.ts`. Mode 0600, directory 0700. `AGENTBOARD_DB_PATH` moves the database. |
| `agentboard.db.recovery/ownership.db` | Database ownership lock (`src/server/persistence/ownership.ts`). Lives beside the database file, wherever that is. |
| `agentboard.db.before-catalog-schema[.N]` | One-time backup before the catalog migration (`src/server/persistence/schema.ts`). |
| `server.lock` | Single-instance lock (`src/server/instanceLock.ts`). |
| `media-index.sqlite` | Media index (`src/server/mediaIndex.ts`). |
| `devin-sessions/` | Devin mirror and `.sync-state.json` (`src/server/devinSync.ts`). |
| `agentboard.log` | Logger (`src/server/logger.ts`); `LOG_FILE` moves it. |
| `tmux-server.pid` | tmux server PID, written atomically by `SessionManager`; `AGENTBOARD_TMUX_PID_FILE` moves it. |
| `stall-samples/` | macOS `sample` reports, newest 20 (`src/server/stallWatchdog.ts`). |

Thumbnails have no disk cache. Temporary files live outside the data directory: `$TMPDIR/agentboard-upload-*`, `/tmp/paste-*`, and `$TMPDIR/agentboard-pipes/`.

### Main database

`agentboard.db` holds two families of tables:

- **`agent_sessions`**: one row per provider conversation (transcript). Key columns: `session_id`, `log_file_path` (both unique), `agent_type`, `display_name`, `current_window`, `is_hibernating`, `last_user_message` (clamped to 8,192 characters), `last_known_log_size`, `slug`, `launch_command`. A row with `current_window` set is active. A dormant row (`current_window IS NULL`) is hibernating when `is_hibernating = 1` and history otherwise. An unexpected window loss hibernates; a deliberate kill moves to history. `is_hibernating` replaced `is_pinned`: it is a lifecycle marker, distinct from the catalog's user-facing `pinned`. Startup never wakes hibernating sessions.
- **`app_settings`**: key/value. Keys include `tmux_mouse_mode`, `inactive_max_age_hours`, `prefer_window_name`, `terminal_colors_enabled`, `synced_settings.<key>`, `persistence_host_id`, `persistence_tmux_epoch`, `persistence_last_saved`, `persistence_settings`, and `catalog_schema_version`.
- The catalog tables in [Session-recovery catalog](#session-recovery-catalog).

`agent_sessions` has no version table. `initializeConnection` runs idempotent migrations that inspect columns with `PRAGMA table_info`, then creates indexes.

SQLite settings (`initializeConnection`, `src/server/db.ts`):

- `busy_timeout = 250` first, so the WAL switch also gets the short wait. bun:sqlite waits for locks synchronously on the main thread; a poll can issue about 25 writes; a longer timeout would freeze the server while another process holds the lock.
- `journal_mode = WAL`, so readers never block a writer. If the switch fails (an old server mid-write during an upgrade), the server stays on the current mode and converts on the next start.
- `synchronous = NORMAL` only when WAL took. NORMAL is safe under WAL and skips the per-commit fsync.
- `busy_timeout` caps lock waits, not write time. A WAL auto-checkpoint runs on the committing thread, so any main-thread write can still stall. Skip writes that change nothing, as `persistence_tmux_epoch` does.

Other connections: `sessionReadWorker` opens the database read-only (`query_only`, 2 MiB cache, `busy_timeout = 250`). Its results are hints; the main thread re-reads rows before it writes. `ownership.db` uses `busy_timeout = 1000`. `media-index.sqlite` uses WAL and `busy_timeout = 5000`.

### Session-recovery catalog

The catalog (`src/server/persistence/`) gives every managed session a stable board identity that survives crashes, reboots, and the absence of a provider log. It covers only windows in the managed tmux session of this server; discovered and remote sessions keep the discovery behaviour above. User-facing behaviour is in [session-recovery.md](session-recovery.md).

**Tables** (`schema.ts`, in `agentboard.db`):

- `board_sessions`: ID, name, project, host, agent type, command, `state` (`starting`, `running`, `interrupted`, `hibernating`, `archived`, `failed`), `pinned`, `current_window` with `epoch`, `last_run_id`, `requested_state`, `origin` (`managed`, `discovered`, `imported`), and the optional terminal preview. A unique index on `(host_id, epoch, current_window)` binds one row to a window per tmux server lifetime.
- `session_runs`: one row per launch, with a unique `operation_id` (the idempotency key) and at most one open run per session.
- `session_conversations`: every provider conversation a board session has had.
- `session_events`: the timeline.

The schema version is `app_settings.catalog_schema_version` (`CATALOG_VERSION = 1` in `schema.ts`). A newer version is rejected. Before the first migration of a database that already holds sessions, `VACUUM INTO` writes `agentboard.db.before-catalog-schema` (a numbered suffix if it exists); fresh installs skip it. This version is unrelated to the WebSocket `CATALOG_VERSION` in `src/shared/catalogProtocol.ts`.

**tmux identity** (`tmuxIdentity.ts`):

- The epoch is a random UUID stored once per tmux server as the global option `@agentboard-server-id`. Window numbers reused after a tmux restart therefore cannot claim an earlier run. The epoch is cached per tmux server PID, so steady state never spawns tmux for it.
- Each window carries `@agentboard-session-id` and `@agentboard-run-id`. They ride the refresh pipeline's own `list-windows`, so reconciliation reads no extra tmux state in steady state. Launch, resume, stop, and anomaly confirmation read identity directly.
- `launch` commits the intent (row plus run) before spawning. `createWindow` creates the window as `__ab_launch__<boardId>__<runId>`, then sets both options and the final name in the same tmux command sequence. A pane whose tagging was interrupted is still recognised by that provisional name. The pane also gets `AGENTBOARD_SESSION_ID` and `AGENTBOARD_RUN_ID` environment variables.
- If `createWindow` fails, a fresh identity read looks for the tagged pane; the run stays open for adoption if it exists, and the row becomes `failed` otherwise. No second process is launched.

**Reconciliation** (`PersistentSessions.beforeSnapshot` and `observe`, `manager.ts`) runs on every refresh against the refresh's own window list:

- An enumeration without a tmux server PID skips reconciliation, so an empty or failed listing cannot interrupt anything.
- Rows that look gone or retagged trigger one independent identity read for the batch (`confirmSnapshot.ts`). If that read fails or the epoch changed meanwhile, the whole pass aborts before any claim is released. An empty tag is unknown, never evidence of another owner.
- An active row with `requested_state` set: kill its tagged window, then move to that state.
- An active row whose run tag is live: bind it `running` and re-point its conversation at the window.
- An active row whose epoch differs or whose window is gone: `interrupted` ("Process stopped unexpectedly"). A definite tag mismatch: `interrupted` ("Window identity changed"). Its conversation's window claim is released only while it still points at this row's window.
- When the epoch changes, every `agent_sessions` window claim from the old tmux lifetime is orphaned.
- Reconciliation never kills an unexpected pane. `observe` adopts untracked managed windows as `discovered` rows, re-adopts `interrupted` and `failed` rows whose windows reappear, and never revives `hibernating` or `archived` rows. One failing session does not abort the pass.

**Stop and resume.** `stop` persists `requested_state` and an event before killing exactly the tagged run; a failed kill clears `requested_state`, so a later refresh does not kill silently. `resume` returns the live session when its run is still running, and refuses (409) while a launch is in progress, while the conversation belongs to another live board session, or while it still runs in another tmux session. Repeating a launch with the same `operationId` returns the live session or 409; it never launches twice.

**Paired writes.** The log poller still writes `agent_sessions.current_window` for rows the catalog does not track (codex exec, discovered windows, rows not yet imported). The catalog and `agent_sessions` are therefore both written: a rename updates `board_sessions.name` and `agent_sessions.display_name`, and the rename goes to tmux before the catalog so a refused rename leaves no name the window does not have.

**Import.** On construction and after each `observe`, `legacyImport.ts` imports up to 100 `agent_sessions` rows without a catalog link per pass, through `sessionReadWorker`. A row whose window is in the managed session becomes `interrupted`; one running in another tmux session becomes `archived`; dormant rows map from `is_hibernating`.

**Settings** (`persistence_settings`, `settings.ts`) default off so nothing writes or relaunches in the background without opt-in. `autoResume` reconciles once at startup, then resumes every interrupted row (`src/server/index.ts`). `capturePreviews` makes `PersistenceRuntime.tick` (`runtime.ts`, every `AGENTBOARD_PERSISTENCE_MAINTENANCE_MS`, default 5000 ms) capture up to 10 tagged windows per tick with `capture-pane -S -80`, keeping the last 32,768 characters with a timestamp. `GET /api/library/:id` returns the preview.

**Locks.** Two locks keep one server per database:

- `<dataDir>/server.lock` (`instanceLock.ts`) is a JSON PID file keyed on the data directory. Two servers on one data directory are unsafe because each reconcile loop treats windows it cannot see as gone. A lock is ignored when its PID is dead, is this process, or was written on another host.
- `<db>.recovery/ownership.db` (`ownership.ts`) holds an open `BEGIN EXCLUSIVE` transaction for the life of the process, keyed on the canonical database path (which `AGENTBOARD_DB_PATH` can move). The OS releases it on a crash. Connections in one process share it by reference count.

**Limits.** History pages hold 1–100 rows (default 50) with a keyset cursor; search also matches earlier names. A detail view returns the last 100 events. Previews of the last prompt are clamped to 8,192 characters. Nothing prunes catalog rows.

### Media index

`media-index.sqlite` is derived data: deleting it costs a rescan. Tables: `media_meta`, `media_sessions`, `media_files` (per-file checkpoints), `media_items`, `media_seen`. A session's identity is the SHA-256 of `[sessionId, logFilePath, agentType]`.

## HTTP and WebSocket surface

There is no authentication. The only origin check rejects cross-origin non-GET requests under `/api/library` (`src/server/persistence/routes.ts`). `/ws` is upgraded before Hono routing.

| Purpose | Routes |
| --- | --- |
| Health and info | `GET /api/health`, `GET /api/server-info`, `POST /api/client-log` |
| Sessions | `GET /api/sessions`, `GET /api/session-preview/:sessionId`, `GET /api/directories` |
| Pull requests | `POST /api/pr-info`, `GET /api/pr-checks` |
| Media (`mediaRoutes.ts`) | `GET /api/session-media/:sessionId/items`, `GET /api/session-media/:sessionId/neighbors`, `GET /api/session-media/:sessionId` |
| Server-side settings | `GET`/`PUT` `/api/settings/tmux-mouse-mode`, `/api/settings/terminal-colors`, `/api/settings/prefer-window-name`, `/api/settings/synced`, `/api/settings/history-max-age-hours` (alias `/api/settings/inactive-max-age-hours`) |
| Paste | `POST /api/paste-file` (`routes/pasteFile.ts`), `POST /api/paste-image`, `GET /api/clipboard-file-path` |
| Recovery catalog (`persistence/routes.ts`) | `GET /api/library`, `GET /api/library/health`, `PUT /api/library/settings`, `GET /api/library/:id`, `POST /api/library/:id/resume`, `PATCH /api/library/:id` |
| Static UI | everything else, from `AGENTBOARD_STATIC_DIR` (default `./dist/client`) |

WebSocket messages (`ClientMessage` and `ServerMessage` in `src/shared/types.ts`):

| Direction | Group | Types |
| --- | --- | --- |
| Client → server | Transport and lease | `ping`, `terminal-resume`, `terminal-ack` |
| | Terminal I/O | `terminal-attach`, `terminal-detach`, `terminal-input`, `terminal-paste`, `terminal-resize`, `tmux-check-copy-mode`, `tmux-cancel-copy-mode` |
| | Session lifecycle | `session-create`, `session-kill`, `session-rename`, `session-refresh`, `session-wake`, `session-hibernate`, `session-move-to-history` |
| Server → client | Handshake and settings | `server-config`, `synced-settings`, `pong`, `error` |
| | Transport | `terminal-lease`, `terminal-overload` |
| | Live sessions | `sessions`, `session-update`, `session-created`, `session-removed`, `host-status`, `kill-failed` |
| | Conversations and lifecycle results | `agent-sessions`, `agent-sessions-active`, `session-orphaned`, `session-activated`, `session-wake-result`, `session-hibernate-result`, `session-move-to-history-result`, `library-changed` |
| | Terminal stream | `terminal-output`, `terminal-ready`, `terminal-error`, `clipboard-offer`, `tmux-copy-mode-status` |

**Protocol version.** The client connects to `/ws?catalog=2` (`CATALOG_VERSION` in `src/shared/catalogProtocol.ts`). The version rides the upgrade URL because a server cannot renegotiate after it has sent its first snapshot. A socket with another version never joins the broadcast set: it receives an `error` reload notice every 4 s (`src/server/catalogUpgrade.ts`) and pongs, instead of a catalog it cannot parse or a close it would retry forever. A matching socket receives `server-config`, `sessions`, `host-status`, `synced-settings`, and `agent-sessions` on open.

## Client

`src/client/main.tsx` mounts `App.tsx` and registers the service worker in production (`vite-plugin-pwa`, `autoUpdate`; the fallback excludes `/api` and `/ws`).

- **Stores** (Zustand, `src/client/stores/`). `sessionStore` holds live sessions, conversations (active, hibernating, history), host status, selection, and connection state; only the selection persists (`agentboard-session`, per-tab storage). `settingsStore` holds UI and device preferences, persisted as `agentboard-settings` with a versioned `migrate`. `themeStore` holds the theme.
- **Synced settings** (`src/client/syncedSettings.ts`, `src/shared/syncedSettings.ts`). Keys in `SYNCED_SETTINGS_KEYS` (theme, presets, list preferences, sounds, filters) are canonical on the server in `app_settings`. The server pushes the full set in `synced-settings`; local changes go out with `PUT /api/settings/synced` after 200 ms. Echoes are suppressed against the last confirmed value, and a key with a pending push keeps its local value.
- **WebSocket** (`src/client/hooks/useWebSocket.ts`). One `WebSocketManager` per document. It negotiates the catalog version, then sends `terminal-resume`. It pings every 20 s and declares the socket dead after 10 s without a pong. Visibility change, `pageshow`, and a clock jump over 15 s trigger a 1.5 s verification ping; a healthy socket stays, and terminals re-attach. Reconnect backoff is exponential to 30 s and pauses while the page is hidden. Overload backoff (1 s doubling to 30 s) is separate and clears only after 30 s of verified, visible, attached use. Terminal frames for an old `attachId` are dropped but still acknowledged.
- **Terminal** (`src/client/hooks/useTerminal.ts`, `components/Terminal.tsx`). xterm.js 6 with `scrollback: 0` (tmux owns scrollback) and the fit, clipboard, search, serialize, progress, and web-links addons; WebGL is optional. Typing goes out as `terminal-input`, paste as `terminal-paste`. An attach goes out whenever the session, target, or connection epoch changes; switching sessions caches a serialised snapshot (up to 20) for an instant switch back. Output is acknowledged after the parser finishes.
- **Recovery drafts** (`hooks/useRecoveryDraft.ts`, `utils/recoveryDraftStorage.ts`). Text typed or pasted while a terminal is not ready goes into a per-terminal draft in localStorage, at most 64 KiB across 128 drafts. It is never sent automatically; **Send** delivers it as one bracketed paste without Enter. The key includes the tmux server PID, and falls back to `createdAt` only when the PID is unknown.
- **Settings registry** (`src/client/components/settings/`). Each row is a `SettingsRowDef` in `rows/*.tsx`, collected into `SETTINGS_ROWS` (`registry.ts`). A page renders the rows whose `page` matches, and search runs over the same list, so a row is defined once. Server-backed rows use `useServerSetting`.
- **Sounds** (`src/client/utils/sound.ts`). See [notifications.md](notifications.md).

## When you add X, also change Y

| When you add or change | Also change |
| --- | --- |
| A Worker entry file | Add it to the `bun build --compile` entrypoint list in `.github/workflows/release.yml` **and** in the compiled smoke test in `.github/workflows/ci.yml`. Load it with `resolveWorkerPath`. Only the two media discovery workers are checked by a test (`src/server/__tests__/workerPath.test.ts`); a missing entry for any other worker fails only in the compiled binary. |
| A server test that patches `Bun.serve`, `Bun.spawnSync`, `process.exit`, timers, or module-level config, or that imports `src/server/index.ts` | Add its file name to `ISOLATED_FILES` in `scripts/test-runner.ts`, or put it in `src/server/__tests__/isolated/` (each file there runs in its own process automatically). |
| A server test that starts real servers, PTYs, or tmux | Add it to `ISOLATED_REAL_TMUX_FILES` in `scripts/test-runner.ts`. These run without coverage and are skipped by `--skip-real-tmux` (`test:ci`). |
| A client test with a top-level `mock.module`, a replaced `document`, or anything that renders `motion/react` | Add it to `ISOLATED_CLIENT_FILES` in `scripts/test-runner.ts`. Module mocks and motion's frame callbacks leak into later files in the same process; failures then appear in unrelated files and depend on file order (Linux CI). |
| A test in a new directory | `scripts/test-runner.ts` globs only `src/server/__tests__/*.test.ts`, `src/server/__tests__/isolated/*.test.ts`, `src/shared/__tests__`, and `src/client/__tests__/*.test.{ts,tsx}`. Other locations are not run. |
| A subprocess spawn | Pass `env` (`sanitizedTmuxEnv()`), or use `timedSpawnSync`/`timedSpawnAsync`. |
| A WebSocket message type | `src/shared/types.ts`. A terminal message handled by the relay also goes in `TERMINAL_TYPES` (`relay/leases.ts`). An incompatible catalog change bumps `CATALOG_VERSION` in `src/shared/catalogProtocol.ts`. |
| A synced setting | `SYNCED_SETTINGS_KEYS` and its validator in `src/shared/syncedSettings.ts`, plus the store field. |
| A settings row | A `SettingsRowDef` in `src/client/components/settings/rows/`, registered through `registry.ts`. |
| An agent type | The `agent_type` CHECK in `src/server/db.ts` (a CHECK change needs a table-rebuild migration), the roots in `src/server/logDiscovery.ts`, and the FAD parity fixtures (`AGENTS.md`). |
| An environment variable | `src/server/config.ts` and [configuration.md](configuration.md). |
| A Devin mirror format change | Bump `MIRROR_FORMAT_VERSION` in `src/server/devinSync.ts`. |
| Thumbnail output | Bump `THUMBNAIL_VERSION` (`mediaThumbnailDecoder.ts`), which keys the server cache. Browsers cache thumbnail responses as `immutable` for a year by URL, so an incompatible output change also needs a new `thumbnail=` value in `hooks/useMediaThumbnail.ts` and `mediaRoutes.ts`. |
| Anything, before commit | The pre-commit hook (`.githooks/pre-commit`, installed by `bun install` through `prepare`) runs `bun run lint`, `bun run typecheck`, and the full `bun run test`, including the real-tmux suites. |
