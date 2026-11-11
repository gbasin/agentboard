# Architecture

This page maps the Agentboard server and client as the code stands. Read it before you change the server. File paths are the anchors: when this page and the code disagree, the code is right and this page needs a fix in the same pull request.

User-facing behaviour and the environment variables are in [configuration.md](configuration.md). This page names a variable only where it explains a mechanism.

Some statements here rest on a measurement or an experiment. This page states the current rule and links the pull request that holds the evidence; a linked file exists at that commit, not in the current tree.

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
| `src/server/terminal/` | Terminal proxies: `PtyTerminalProxy`, `PipePaneTerminalProxy`, `SshTerminalProxy`. `PaneOutputFeed.ts` shares one pane's `pipe-pane` output between viewers. `startOwnedTerminal.ts` holds the shared startup step and the SSH session name. |
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
| Dashboard | `Bun.serve` in `src/server/index.ts` | With the relay on: `127.0.0.1`, an ephemeral port, no TLS. With the relay off: `HOSTNAME`:`PORT`, with TLS when `TLS_CERT` and `TLS_KEY` are both set. |
| Public relay | `Bun.serve` in `src/server/terminalRelayWorker.ts` | `HOSTNAME`:`PORT` (default `127.0.0.1:4040`), with TLS when `TLS_CERT` and `TLS_KEY` are both set. |
| Tailscale | `tailscaleReady` in `src/server/index.ts` | The Tailscale IPv4 address on `PORT`, only when `HOSTNAME` is `127.0.0.1`. The relay worker opens it with a `bind` message; with the relay off, the main thread opens a second `Bun.serve`. With `HOSTNAME=0.0.0.0` the address is only logged. |

Preview listeners register the detected Tailscale interface independently of the dashboard listener. If Tailscale Serve already owns the dashboard port, previews still bind their separate ports on that interface.

The relay is on unless `AGENTBOARD_TERMINAL_RELAY=0`, or `NODE_ENV=test` without the variable (`relayEnabled` in `src/server/index.ts`).

With the relay on, browsers reach only the relay listener. It upgrades `/ws` itself. It proxies every other request to the loopback dashboard listener, and answers 503 when that fails. On the WebSocket it answers `ping` itself, and `TerminalLeases.handle` (`src/server/relay/leases.ts`) takes `terminal-resume`, `terminal-ack`, and the terminal messages in `TERMINAL_TYPES`. For a socket whose catalog version matches, it forwards all other messages to the main thread; for a mismatched socket it forwards nothing (`terminalRelayWorker.ts`). Forwarded messages reach `relayMessage` (`src/server/index.ts`), which wraps each relay socket in a stand-in `ServerWebSocket` and runs the normal handlers. Terminal output therefore never passes through the main event loop. That separates threads, not traffic: terminal frames, catalog frames, and pongs still share each browser's one WebSocket (see [Client](#client)).

The `HOSTNAME` that a container exports automatically (equal to `os.hostname()`) is ignored (`resolveBindHostname` in `src/server/config.ts`).

### Workers

Every worker entry file is `src/server/*Worker.ts`, including the relay, lease, and pane-output workers; `src/server/relay/` holds only their supporting modules. Each client resolves its worker's path with `resolveWorkerPath` (`src/server/workerPath.ts`).

| Worker | Spawned by | Job | Own SQLite | Spawns processes |
| --- | --- | --- | --- | --- |
| `terminalRelayWorker` | `TerminalRelayClient` (`relay/client.ts`) | Public listener, lease table | no | no |
| `terminalSessionWorker` | `TerminalLeases.startWorker` (`relay/leases.ts`), one per terminal lease, `smol` | One terminal: tmux client PTY or SSH, paste, clipboard poll. In `pipe-pane` mode it subscribes to `paneOutputWorker` for output. | no | yes |
| `paneOutputWorker` | `PaneOutputRouter` (`relay/paneOutputRouter.ts`), inside the relay worker; one instance, started on the first `pipe-pane` subscription, `smol` | One `pipe-pane` and one `tail` per tmux pane, shared by every viewer of that pane | no | yes (tmux, `tail`) |
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
- A `paneOutputWorker` failure is fatal too. `PaneOutputRouter` first turns `pipe-pane` off on the panes the worker piped, kills their `tail` processes, and deletes their temporary directories. It then reports `fatal`, and the main thread exits 1.
- `sessionRefreshWorker` and `logMatchWorker` have per-request timeouts. On a timeout the client fails pending requests and starts a new worker.
- `sessionMetadataWorker` retries after failure with backoff from 1 s to 30 s. `sessionActivityWorker` has a 10 s scan timeout (re-armed on progress) and, after a failure, a fixed 1 s wait before the next attempt (`sessionActivityClient.ts`).
- The media discovery RPC keeps a timed-out request's slot until the worker replies. New requests fail meanwhile. A worker is replaced only after a confirmed `close`, because native work may still be running (`mediaDiscoveryRpc.ts`).
- A `mediaThumbnailWorker` error disables thumbnails until restart.
- `devinSyncWorker` and `sessionReadWorker` only log slow requests. A second Devin worker would append the same rows and race on the temporary file (`devinSyncWorkerClient.ts`).

### Worker rules

- Do not call `worker.terminate()` in new code. Comments in `logMatchWorkerClient.ts`, `sessionRefreshWorkerClient.ts`, `devinSyncWorkerClient.ts`, `stallWatchdog.ts`, and `mediaThumbnailClient.ts` record that it segfaults compiled Bun binaries (BUN-118B); `sessionReadClient.ts` gives the same reason without the bug ID. One exception exists: `SessionActivityClient.retire` (`sessionActivityClient.ts`) calls `worker.terminate()` (tracked in issue #476).
- How clients stop a worker instead:
  - Most post a `shutdown` message; the worker handles it synchronously in `onmessage` and calls `self.close()` there (`sessionRefreshWorker`, `devinSyncWorker`, `sessionReadWorker`, `sessionMetadataWorker`, the two media discovery workers, `mediaThumbnailWorker`, `stallWatchdogWorker`). Keep that handler synchronous. The thumbnail work recorded that `self.close()` called from an async `onmessage` exited the process with SIGTRAP (status 133) on Bun 1.3.14, from source and from a compiled binary ([#448](https://github.com/gbasin/agentboard/pull/448), [`docs/investigations/iphone-heartbeat/thumbnails/backend.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/investigations/iphone-heartbeat/thumbnails/backend.md)).
  - `logMatchWorker` and `sessionActivityWorker` have no shutdown handler. `LogMatchWorkerClient` drops its reference to the old worker and lets process exit clean it up.
  - `terminalSessionWorker` and `terminalRelayWorker` dispose asynchronously on `shutdown`, reply `stopped`, and deliberately never close (next rule).
  - `paneOutputWorker` does the same for `pane-shutdown`: it releases every subscription, replies `pane-stopped`, and stays inert until the process exits.
- Never close a PTY worker realm during normal service. The comments in `relay/leases.ts` and `terminalRelayWorker.ts` record that closing a nested Bun PTY realm SIGTRAPs the process on Bun 1.3.14 for macOS. `TerminalLeases` reuses a worker only after it acknowledges disposal with `stopped`, and process exit owns the realms at shutdown.
- On macOS, PTY creation is serialised across terminal workers by an Atomics lock on a shared 4-byte buffer (`relay/ptySpawnLock.ts`). The file's header comment records that concurrent PTY creation on Bun 1.3.14 for macOS can leave the main thread's signals blocked. The lock covers only the synchronous spawn call, applies only on darwin with a terminal, and refuses to run on the main thread. A waiter gives up after 5 s. The investigation linked in the Bun rule below gives the reason for that scope: on macOS, Bun sends a spawn with a terminal through its own `fork` path, which blocks signals around the fork, and sends every other spawn through `posix_spawn`. It also records that serialising worker startup, instead of the spawn call, did not prevent the failure.
- Workers keep the process-start environment, so post-start changes to `process.env` (such as the nested-tmux isolation) do not reach them. Seven spawn sites pass `env` to `new Worker`: the relay, lease, and pane-output workers get `workerEnvironment()` (`relay/protocol.ts`); the metadata, activity, media discovery, and thumbnail workers get `sanitizedTmuxEnv()`. `sessionRefreshWorker`, `logMatchWorker`, `devinSyncWorker`, `sessionReadWorker`, and `stallWatchdogWorker` are spawned without `env`. Code in those workers must pass `env: sanitizedTmuxEnv()` on every spawn, as the refresh worker and `logMatcher.ts` do; `sanitizedTmuxEnv()` strips `TMUX` itself whenever `TMUX_TMPDIR` is set. `stallWatchdogWorker` spawns `sample` without `env`.
- These Bun constraints are tied to the pinned Bun version (`.bun-version`). Re-test them when you upgrade Bun. For the PTY lock, the checks are `src/server/__tests__/ptySpawnLock.test.ts` and `bun scripts/verify-terminal-relay-binary.ts <binary>`, which attaches six terminals at once and then requires SIGTERM to finish within 10 s. The failure is intermittent in compiled binaries, so one passing run without the lock does not show that the lock can go ([#448](https://github.com/gbasin/agentboard/pull/448), [`docs/investigations/pty-spawn-signal-mask.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/investigations/pty-spawn-signal-mask.md)). For the thumbnail worker's codecs, deadline recovery, and shutdown, the check is `scripts/verify-media-thumbnail-worker.ts`, which CI compiles and runs.
- Loggers inside workers write synchronous JSON. `logger.ts` uses pino transports (`pino-pretty`) only on the main thread of a source checkout; its comments record that nested transport workers can crash Bun when a worker shuts down, and that compiled binaries cannot load transports.

### Startup and shutdown

`src/server/index.ts` runs its startup as top-level module code, in this order:

1. Nested-tmux guard (`decideNestedTmux`, `src/server/tmuxIsolation.ts`). It runs before any tmux spawn.
2. Port check with `lsof`; exit 1 if the port is taken.
3. Single-instance lock `<dataDir>/server.lock` (`src/server/instanceLock.ts`); exit 1 if held.
4. `tmux -V` (`src/server/prerequisites.ts`) and terminal-mode resolution.
5. `initDatabase({ exclusive: true })`, which takes the database ownership lock. Then settings from `app_settings`, `SessionManager`, and a synchronous `ensureSession()` for the managed session.
6. Clients, the log poller, the refresh interval (`REFRESH_INTERVAL_MS`, default 2000 ms), the stall watchdog, and then the event-loop lag monitor (500 ms tick), which also sends the watchdog's heartbeat.
7. The dashboard listener, then the relay, then the `server_started` log line, then the Tailscale lookup. The Tailscale lookup (`tailscale ip -4`, 5 s timeout, `src/server/tailscale.ts`) runs after the listener is up, so a slow `tailscaled` never delays startup.
8. The startup sequence (`startupReady`): an async refresh, the ownership observer, `logPoller.start()`, `startupHousekeeping()` (scrub leaked tmux environment variables, prune orphaned grouped sessions), then startup verification. The poller starts only after the first refresh, because its first snapshot would race the worker spawns of boot.

SIGINT and SIGTERM run `cleanupAllTerminals()` and exit 0. It shuts the relay down first, then stops timers and workers, then closes the database. The relay's shutdown retires every lease and then waits for `paneOutputWorker` to release its pipes. If the relay misses its 6 s shutdown deadline, `TerminalRelayClient` reports `fatal`, and `relayMessage` exits the process with code 1 (`relay/client.ts`, `src/server/index.ts`). The `exit` handler releases `server.lock`.

## The tmux model

### Managed session and bootstrap window

Agentboard owns one tmux session, `TMUX_SESSION` (default `agentboard`). Each agent session is a window in it. `SessionManager.createWindow` names new windows from the request or `generateSessionName()` (`adjective-noun`, `src/server/nameGenerator.ts`). Names are validated by `src/server/windowName.ts`: at most 120 characters, no control characters, no `\` (tmux format output escapes it, so the name could not round-trip). Windows are always addressed by window ID (`<session>:@<id>`), never by name. A live session's `id` is that tmux target.

tmux needs at least one window per session, so `ensureSession` creates the managed session with a bootstrap window `__agentboard_root__` running `tail -f /dev/null` (`src/server/tmuxFormat.ts`). That name is reserved: it is hidden in every session, and create and rename refuse it.

`ensureSession` probes with `display-message -p -t =<name>:`. The `=name:` form matters for two reasons: a bare `=name` parses as a pane target, and without the exact match a grouped `<name>-ws-*` session would satisfy the probe and the base would never be created. When the probe fails with a connection error and `tmux-server.pid` names a live tmux process, `ensureSession` sends it SIGUSR1 (which makes tmux recreate its socket), at most once per 30 s, and probes again. If the session is still absent and `list-sessions` also fails, it refuses to start a replacement server. In every other case (no PID file, a dead or non-tmux PID, or a reachable server without the session) it creates the session normally (`SessionManager.ts`). If a grouped session survives without its base, the base is recreated as a member of that group.

All tmux format calls use tab-separated fields and `tmux -u`, which keeps tabs intact under minimal locales (`tmuxFormat.ts`). `escapeTmuxFormatArg` doubles `#` because tmux format-expands window-name arguments.

### Discovered sessions

Windows in every other tmux session appear as discovered (external) sessions. `DISCOVER_PREFIXES` narrows that to sessions whose names start with a listed prefix. `<base>-ws-*` sessions are never discovered. The refresh worker also drops any discovered window whose window ID belongs to the managed session (`sessionRefreshWorker.ts`): grouped and linked sessions would otherwise duplicate managed windows, and killing a duplicate kills the real window. Killing discovered sessions needs `ALLOW_KILL_EXTERNAL=true`.

Remote hosts (`src/server/remoteSessions.ts`) are polled over SSH with one `tmux list-windows -a` and one batched capture per host. Their session IDs are `remote:<host>:<session>:<@id>`. A host whose last poll failed, or whose last good poll is older than `AGENTBOARD_REMOTE_STALE_MS`, contributes no sessions to the list (`getSessions`). Its state is published separately as `host-status`, so the client can show a host that is down while its sessions are gone. Viewing and controlling are separate permissions (`config.ts`): `AGENTBOARD_REMOTE_ALLOW_ATTACH` gates terminal attach and input, and `AGENTBOARD_REMOTE_ALLOW_CONTROL` gates create, kill, and rename. Attach takes the value of control when it is unset. Both attach paths check it: `TerminalRuntime` with the relay, and `src/server/index.ts` without.

### Grouped sessions

A browser terminal never attaches to the managed session directly. `PtyTerminalProxy` creates a per-terminal session grouped with it, named `<TMUX_SESSION>-ws-<id>` (`createGroupedSession`, `src/server/tmuxGroupedSession.ts`). With the relay, `<id>` is the terminal lease ID; without it, the WebSocket connection ID. A dashboard-only tab has no lease worker and no grouped session. The grouped session has its own current-window pointer, so browsers switch windows without moving each other or your own tmux clients. The proxy copies `mouse` from the base, sets `allow-passthrough on`, and turns `status off`; the comment there records that tmux keeps redrawing a status bar nobody sees, at a measurable CPU cost.

To view a discovered session, the proxy creates a mirror grouped with it, `<ws-session>-x-<sanitized>-<hash>`. It checks `has-session =<raw>` first, because `new-session -t` with an unknown name silently starts an unrelated group. It validates membership by window, not by group name, because group names survive a kill and recreate.

Each `new-session -t` spawns and immediately destroys a login shell. The comment in `tmuxGroupedSession.ts` records that on macOS such a shell can lose its PTY before it gets a controlling terminal and then block forever, holding a PTY. `ThrowawayShellReaper` (`src/server/throwawayShellReaper.ts`) finds such shells (direct child of the tmux server, not a pane, dashed argv0, at least 60 s old, no children, only file descriptors 0–2) and sends SIGHUP, then SIGKILL. It runs only on macOS. Grouped-session creation only re-arms its timer: do not add process listing or any other spawn to `createGroupedSession`. The same comment records that synchronous `ps` calls there made a loaded server stop answering.

The per-terminal `<base>-ws-<id>` session is killed when its proxy is disposed. A mirror of a discovered session is killed when the terminal switches away from it (`releaseUnusedExternalGroupedSessions`, `PtyTerminalProxy.ts`); the mirror in use is killed at disposal. With the relay, disposal follows lease retirement, so a grouped session can outlive a disconnected browser by the 60 s grace period (see [Relay leases](#relay-leases)). At startup, `startupHousekeeping` calls `pruneOrphanedWsSessions` (`src/server/startupVerify.ts`), which kills unattached `<base>-ws-*` sessions that no live socket or lease owns. The environment variable `PRUNE_WS_SESSIONS=false` (read in `config.ts`) turns this off, and pruning is skipped when `ensureSession` could not read the session groups.

### Nested-tmux guard and subprocess environment

An agent inside an Agentboard pane inherits `$TMUX`. A server started there would join the live tmux server and see live windows as discovered duplicates. `decideNestedTmux` (`src/server/tmuxIsolation.ts`) decides at startup:

1. No `$TMUX`: proceed.
2. `TMUX_TMPDIR` set: isolate. Delete `TMUX` and `TMUX_PANE` from `process.env` and create the directory (tmux ignores a missing `TMUX_TMPDIR` and falls back to the default socket).
3. `AGENTBOARD_ALLOW_NESTED_TMUX=true`: proceed on the shared server.
4. Otherwise refuse when the pane's session holds `__agentboard_root__`. A failed probe counts as managed.

`Bun.spawn`/`spawnSync` without `env`, and every Worker, use the process-start environment and miss step 2. A new subprocess must therefore pass `env` explicitly. One existing spawn does not: `stallWatchdogWorker` runs `sample` with the process-start environment. `sanitizedTmuxEnv()` (`src/server/tmuxEnv.ts`) removes `NODE_ENV`, `AGENTBOARD_STATIC_DIR`, and `npm_*`, which a tmux daemon would otherwise capture permanently for every later pane. It also removes `TMUX` and `TMUX_PANE` when `TMUX_TMPDIR` is set. It adds nothing. `timedSpawnSync` and `timedSpawnAsync` (`src/server/syncSpawnTiming.ts`) default to it and log spawns slower than 250 ms. `SshTerminalProxy` attaches with `sanitizedTmuxEnv()` plus `TERM`.

### Timeouts and kills

tmux reads time out after `AGENTBOARD_TMUX_TIMEOUT_MS` (3000 ms). Mutations (`new-session`, `new-window`, `kill-*`, `switch-client`, `rename-window`, `set-*`, and others) use `AGENTBOARD_TMUX_MUTATION_TIMEOUT_MS`, default `max(5 × read timeout, 15000)` ms (`config.ts`). A timeout raises `TmuxTimeoutError` (`src/server/tmuxTimeout.ts`).

The comment in `src/server/tmuxKillGuard.ts` records that `kill-window` on the last window of a grouped session segfaulted tmux 3.7b. For that case the guard moves or detaches clients, kills the other group members, then kills the target session. It refuses on a timeout or an unparseable listing. Kills from one connection are rate-limited to 3 per 5 s (`src/server/killRateLimit.ts`).

## Terminal I/O

### Proxy modes

`TERMINAL_MODE` selects the local proxy (`resolveTerminalMode`, `src/server/terminal/TerminalProxyFactory.ts`). `auto` picks `pty` when stdin is a TTY and `pipe-pane` otherwise. Remote sessions always use `SshTerminalProxy`.

- **`pty`** (`PtyTerminalProxy.ts`, default). Creates the grouped session, spawns `tmux -u [-T sync] attach [-f ignore-size] -t <ws-session>` in a Bun PTY, finds the client TTY in `list-clients`, and switches windows with `switch-client -c <tty>`, verifying the result. `-T sync` makes tmux wrap redraws in DEC 2026 synchronized-update markers. Both flags need tmux 3.2, and each has its own gate. `-T sync` is checked against the client binary's `tmux -V` (cached per process) and is off when `AGENTBOARD_TMUX_SYNC` is `0` or `false`. `-f ignore-size` is checked against the running server's `#{version}`, read in the same command that sets `status off`.
- **`pipe-pane`** (`PipePaneTerminalProxy.ts`). No tmux client and no grouped session. Output comes from one `pipe-pane` and one `tail -F` per tmux pane, through a file in a `$TMPDIR/agentboard-pane-*` directory. Every viewer of the pane shares them (`PaneOutputFeed.ts`); the pane is identified by `#{socket_path}:#{pid}:#{pane_id}`, so aliases and grouped sessions resolve to the same feed. The `pipe-pane` command runs inside an `if-shell` check of the tmux server PID, because a restarted server can reuse both the socket and the pane ID. With the relay on, `paneOutputWorker` owns the feeds. With the relay off, the main thread does. Input goes through `send-keys -l`. Wheel events become copy-mode scroll commands. It cannot opt out of pane sizing.
- **SSH** (`SshTerminalProxy.ts`). Creates a standalone `<base>-ws-<id>-ssh-<attach sequence>` session on the remote host, one per proxy (`sshTerminalSessionName`, `startOwnedTerminal.ts`), and attaches with `ssh -tt`. Commands use `-o ControlMaster=no` to avoid hangs on stale control sockets. Both `-T sync` and ignore-size are gated on the remote server's `#{version}`, which `new-session -P` returns.

### Relay leases

With the relay on, `TerminalLeases` (`src/server/relay/leases.ts`) owns browser terminals. A lease is one browser document's terminal state: a worker, an owning socket, an epoch, and a claim counter. A lease observes an agent pane; it never owns one, so disposing a lease never kills an agent window.

- The client sends `terminal-resume {token, claim}` after the catalog handshake. A new token creates a retained lease and the server answers `terminal-lease`. A known token with a higher claim moves the lease to the new socket, bumps the epoch, and closes the old socket with 4001. A claim that is not newer is rejected with 1008. The client keeps the token in memory only, so a duplicated tab cannot take over the original's lease.
- The lease's `terminalSessionWorker` starts only on the first valid `terminal-attach`. Dashboard-only tabs cost no worker.
- A lease with an owner but no client progress for 90 s is closed with 4001 (`AGENTBOARD_RELAY_PROGRESS_MS`). A client that stops responding without closing its socket therefore cannot hold a lease forever. A detached retained lease is retired after 60 s (`AGENTBOARD_RELAY_GRACE_MS`). A lease created by `terminal-attach` without a prior `terminal-resume` (an older client) is not retained and is retired as soon as its socket closes.
- At most 32 leases, including retiring ones, exist at a time. Idle leases count. When full, the oldest ownerless lease is retired. A lease that never started a worker frees its slot at once. A lease with a worker keeps its slot until the worker replies `stopped`, so the socket that triggered the eviction is still overloaded; this keeps the bound on worker realms. If no lease is ownerless, the new socket is overloaded too.
- `paneOutputWorker` accepts at most 64 pane subscriptions. It holds at most 2 MiB of output per subscription that the lease worker has not yet credited; past that, the subscription ends and the lease takes its overload path.
- Retiring posts `shutdown` and waits for `stopped`. After 5 s it only logs `terminal_worker_disposal_delayed`. Until the worker replies, the realm stays counted and is not reused, so one stuck tmux cleanup costs one slot instead of the service. A worker that replies, even late, joins the idle pool, and the next lease that needs a worker takes it from there.
- Output budgets are tiered: 1 MiB of unacknowledged output per retained client (the client acks with `terminal-ack` after its parser finishes), 2 MiB from worker to relay awaiting credit, and 16 MiB of payload plus Bun's send buffer per socket. Any overflow sends `terminal-overload` and closes with 1013; ANSI output is never dropped mid-stream. The comment in `relay/leases.ts` records that WebKit may expose the 1013 close as 1005, which is why the `terminal-overload` frame is sent first.
- When the worker reports Enter in local input, the relay posts `submit` to the main thread, which applies the post-Enter status override (see [Status inference](#status-inference)).

`TerminalRuntime` (`relay/terminalRuntime.ts`) runs inside each lease worker. It validates the attach, captures the screen (`capture-pane -p -J`), switches the tmux client, sends history in 12,000-character chunks, and re-checks session identity after each async step. Without the relay, the same work runs on the main thread in `src/server/index.ts`.

### Sizing, paste, clipboard and copy mode

- **Sizing.** tmux sizes a window from its attached clients, so a phone that stays attached in the background would hold a desktop's pane at the phone's size (probe in [#448](https://github.com/gbasin/agentboard/pull/448), [`docs/investigations/terminal-background-pressure/sizing/README.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/investigations/terminal-background-pressure/sizing/README.md)). On tmux 3.2 or later, relay proxies start excluded from window sizing (`-f ignore-size`). An attach opts in with `refresh-client -f !ignore-size` once it is validated and its proxy exists, before the screen capture and the window switch (`TerminalRuntime`). A suspend opts out again; it runs on `terminal-detach` and when the socket closes. Changes are serialised per proxy (`TerminalProxyBase.setSizeParticipation`). A view that left the foreground this way does not constrain the pane's size. Four cases still do: the relay turned off (only `TerminalRuntime` starts a proxy excluded, so every attached view counts until its socket closes), a tmux server older than 3.2 (the flag is not sent, and every attached client counts), `pipe-pane` mode (it has no client to flag), and a browser that the operating system suspends before it sends `terminal-detach`. iOS can do that, and `useWebSocket.ts` treats the detach as best-effort; such a view constrains the pane until its socket closes, which the 90 s progress timeout forces.
- **Paste.** `terminal-paste` goes through `load-buffer` (stdin, avoiding the argv size limit) and `paste-buffer -d -p` (`deliverPasteViaTmux`, `TerminalProxyBase.ts`). `-p` brackets the paste only when the pane's application enabled bracketed paste, so multi-line text is not submitted line by line. There is no fallback to raw writes. `paste-buffer -t` takes a pane target, which rejects the `=name` form, so `PtyTerminalProxy` targets the bare name of the session it last switched into; `PipePaneTerminalProxy` targets the window itself. `SshTerminalProxy` pins the paste to the pane its own client shows when the paste is accepted: it finds that pane through `list-clients` by the client's TTY, and refuses the paste when the terminal is not ready, because an empty client selector would let tmux pick another client. A window switch waits for a pending lookup. Paste never counts as a submit.
- **Uploads.** `/api/paste-file` reads the whole request body into memory (at most 40 MiB plus 64 KiB of multipart overhead), then parses the multipart data itself; the comment in `routes/pasteFile.ts` records that Bun's `formData()` is unreliable. The file is written with mode 0600 into a fresh `$TMPDIR/agentboard-upload-*/` directory; the file itself is limited to 40 MiB. The client then pastes the quoted path. `/api/paste-image` writes `/tmp/paste-*`. Uploads are disabled for SSH sessions.
- **Clipboard.** The `pty` proxy sets tmux `set-clipboard on` (server-global) unless `AGENTBOARD_TMUX_SET_CLIPBOARD` disables it. A left-button press arms a 5 s window; the terminal polls `list-buffers` every 750 ms and offers a new buffer of at most 512 KiB to the browser as `clipboard-offer`. The comment in `PtyTerminalProxy.ts` records that this path matters most on iOS Safari, where the async OSC 52 path cannot satisfy the user-gesture rule. It never runs for remote sessions.
- **Copy mode.** `tmux-check-copy-mode` reads `#{pane_in_mode},#{alternate_on},#{mouse_any_flag}` asynchronously. `CopyModeQuery` (`src/server/copyModeQuery.ts`) drops a result only when a newer completed read was already published, so latency above the poll interval cannot starve the UI. Input and paste queue behind a pending `tmux-cancel-copy-mode`. Without the relay, these handlers run on the main thread, where a synchronous tmux spawn stalls every terminal and every HTTP request until it returns. Each browser sends the copy-mode read on a timer, which is why it is asynchronous ([#418](https://github.com/gbasin/agentboard/pull/418)); keep any handler that a browser calls on a timer asynchronous. `tmux-cancel-copy-mode` still spawns synchronously on that path, once per user action.

## Status inference

A session's status is `working`, `waiting`, `permission`, or `unknown` (`SessionStatus`, `src/shared/types.ts`). It comes from pane content only. Logs do not change it.

Every refresh captures the visible pane (`capture-pane -p -J`, trailing blank lines dropped, last 30 lines kept) with its width and height, in `sessionRefreshWorker.ts`, the synchronous `SessionManager` fallback, or `remoteSessions.ts`. `inferSessionStatus` (`src/server/statusInference.ts`) is a pure function, evaluated in order:

1. First observation with no permission prompt: `waiting`.
2. Content changed: `working`. Working wins over a permission prompt. With unchanged dimensions any difference counts. After a resize, both captures are normalised (last 20 lines, ANSI, decorative lines, timers and UI glyphs stripped) and compared as sets of unique tokens: with fewer than 8 tokens in the larger set, any difference counts; otherwise the content changed when the shared tokens are under 90% of the smaller set. A pure reflow therefore does not count.
3. A permission prompt in the last 10 lines after trailing blank lines are dropped (blank lines inside those 10 count) (`PERMISSION_PATTERNS`, covering Claude Code, Codex, Devin, and generic `[y/n]` prompts): `permission`.
4. Content changed within the working grace period (`AGENTBOARD_WORKING_GRACE_MS`, 4000 ms): `working`. This absorbs an agent's short pauses.
5. Otherwise `waiting`.

When a capture fails, `inferCachedSessionStatus` re-evaluates the cached content; with no cache the status is `unknown`.

**Post-Enter override.** Input containing `\r` or `\n` to a local session calls `setForceWorking` (`src/server/index.ts`). It sets the status to `working` at once and holds it there for the grace period (`src/server/forceWorkingStatus.ts`), so the status does not flicker before the agent prints anything. It also schedules one refresh and a capture of the last user prompt after `AGENTBOARD_ENTER_REFRESH_MS` (1000 ms). The prompt capture locks the window's last-message field for 60 s, so the log poller does not overwrite it with an older value. A capture that is empty, fails, or returns a collapsed paste placeholder releases the lock and lets the transcript supply the prompt. The override applies in the async refresh (on the refresh-worker path and on its synchronous fallback) and in startup verification; only `refreshSessionsSync`, the refresh that follows a mutation, skips it.

Subagent activity (see [Subagent activity](#subagent-activity)) is a separate field and does not change status.

## Log pipeline

Transcripts drive which conversation a window runs, the last user prompt, a session's activity time, PR chips, media, and subagent activity. Status does not come from them.

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

A full cycle (`pollOnce`) reads a snapshot through `sessionReadWorker`, then asks `logMatchWorker` to scan. Without explicit paths, the worker stats every transcript and processes `AGENTBOARD_LOG_POLL_MAX` (default 25) of them per cycle (`LogReconciliation.select`, `logReconciliation.ts`). Half of that budget, rounded up, goes to the newest by mtime. The rest comes in turn from a list of all transcripts that is fixed at the start of each sweep, so old files are reached even while new files keep arriving. A transcript with no database row gets the full read (session ID, project path, slug, token count). A known transcript reuses the row's metadata; the worker reads its file only to fill a missing Codex exec flag, Claude slug, or project path (`enrichLogEntry`, `logPollData.ts`) and for the last-prompt read below. The reader's snapshot holds whole rows, with at most 72 hours of history. The main thread then trims each last message to 2,048 characters as it builds the request for `logMatchWorker` (`toSnapshotMessage`, `logPoller.ts`); the comments there record that unbounded loads dragged the whole table through the main thread and made worker messages very large. Last-prompt reads make one backward pass from the end of the file in 64 KiB chunks, at most 2 MiB deep, with no line limit; a line that crosses that depth is still read whole, up to 16 MiB (`iterateLogLinesBackward`, `logMatcher.ts`). The comment in `logMatchWorker.ts` gives the reason for no line limit: a long agent run can put thousands of lines after the last user message. A session's activity time is the last entry's timestamp when the file grew or its stat revision changed; mtime alone moves on backups and syncs. The mtime is a fallback only when no timestamp can be read and the size or the last message changed.

### Matching a transcript to a window

`agent_sessions.current_window` records which window runs a conversation. A partial unique index allows one row per window. `claimCurrentWindow` (`src/server/db.ts`) is a compare-and-set that succeeds only when the row is unclaimed and no other row holds the window. The paths below write claims in different ways; the exceptions to the compare-and-set are named.

**Process ownership** (`src/server/ownership/`) runs on its own 30 s cycle and outranks text evidence. It runs only on macOS; `AGENTBOARD_OWNERSHIP_MATCHING=false` can turn it off but nothing turns it on elsewhere (`config.ts`). The observer snapshots `tmux list-panes`, `ps`, and `lsof` before and after reading identity, and discards results that changed underneath it. Claude identity comes from `<claudeHome>/sessions/<pid>.json`, read twice and checked against the process start time. Codex identity needs exactly one outermost `codex` process, an open writable `rollout-*.jsonl` with `source` `cli`, and an open thread-writer lock; it never infers identity from cwd or recency. `OwnershipMatcher` (`ownership/matcher.ts`) then moves the window to the observed conversation in one transaction, orphaning its current owner. It refuses when the window's owner changed since the snapshot, the agent types differ, the target row is `codex exec`, the target's transcript path differs from the observed one, the target already owns another window, or either row is hibernating or has a wake in progress. Inspection failures never release a claim. Its evidence also vetoes content and Devin-lock matches that disagree with it (`allowsMatch`).

**Each poll cycle** (`processMatchResponse`, `src/server/logPoller.ts`) picks a window per transcript:

1. For Devin transcripts, the Devin lock match (`src/server/devinLockMatch.ts`): `session_locks/<id>.lock` holds a PID, and the window whose pane PID is its ancestor (at most 64 levels) wins.
2. Otherwise, content matching (below).

Both are subject to the ownership veto. An existing orphaned row is claimed through `claimCurrentWindow`. A new transcript whose match is a window another row already holds is inserted as an orphan instead: the cycle does not steal a claimed window. The exception is slug supersede: a new Claude transcript whose slug and project match an existing session takes over that session's window and name, and the old session becomes an orphan. Both writes are one SQLite transaction (`supersedeSession`, `db.ts`), which aborts when the old row's window, name, slug, project, or hibernation state changed after it was read. A new transcript is inserted only once it has content. Insertion waits while an unclaimed managed window in the same project, with a compatible agent, shows no prompts yet.

**Content matching** (`src/server/logMatcher.ts`). The worker captures each unclaimed window's scrollback (`capture-pane -J -S -10000`), extracts recent prompt lines (`❯` for Claude, `›` for Codex, a background colour for Pi, AskUserQuestion recaps, and trace lines as a last resort), and runs `rg -l` over the roots. For prompt lines, a candidate must contain the text as real user input, not tool output; the trace-line fallback searches without that restriction. Then, in order: a hard agent-type gate (a Claude window never matches a Codex transcript; unknown types pass), a soft cwd gate (applied only when a candidate survives it), and scoring by ordered matches. A tie after a full re-score is no match. When two windows claim one transcript, the higher score wins and an equal score blocks the transcript for that pass. The comment on the agent-type gate records the case it prevents: the same prompt pasted into a Claude and a Codex window seconds apart, where one log flushes first.

**The one-time orphan rematch** runs after the first cycle that completes without errors, and only when some live window has no owner. Its passes run in this order:

1. Content matching, written through `claimCurrentWindow`.
2. Name fallback: a unique, unclaimed, managed window whose name equals the session's display name, written through `claimCurrentWindow`.
3. Devin lock PID, last. This pass writes `current_window` with `db.updateSession`, not the compare-and-set. Its only guard against a taken window is an in-memory set of claimed windows, built before it awaits the lock lookup.

**Which transcripts are tried.** `getEntriesNeedingMatch` (`src/server/logMatchGate.ts`), called from `logMatchWorker.ts` and `logPoller.ts`, selects them: `codex exec` sessions never match; a transcript with no row is always tried; an orphaned row is tried only when its transcript changed and its project path is outside `AGENTBOARD_SKIP_MATCHING_PATTERNS`. Changed means that the size differs from `last_known_log_size`, or that the stat revision (`dev:ino:size:mtimeNs:ctimeNs`) differs from `last_known_log_revision`. A known row older than the 72-hour snapshot is gated on the same two fields, which the worker reads without the row's prompt text. (`shouldRunMatching` in the same file is used only by tests.) The poller then skips hibernating rows unless a wake started within the last 10 minutes (`canAttemptDormantRematch`), and re-matches one session at most once a minute (`REMATCH_COOLDOWN_MS`).

### Startup verification

At startup every claimed window is re-verified (`src/server/startupVerify.ts`, `hydrateSessionsWithAgentSessions` in `src/server/index.ts`). Ownership evidence counts as verified. Other windows go to `logMatchWorker` as one batch (10-minute timeout); without the worker, verification runs inline two windows at a time (`STARTUP_VERIFY_CONCURRENCY`); the comment there records that verifying every window at once overloaded disk and CPU after a restart. A link survives when content verifies or when the window name equals the session's display name. A verification that throws keeps the link; a worker timeout is inconclusive and the name decides. Anything else orphans the session.

When a claimed window is missing from a refresh, `probeWindow` asks tmux directly. Only a definite `absent` orphans the row; an unknown result keeps it with status `unknown`.

### Devin mirror

Devin CLI keeps history in SQLite (`$DEVIN_CLI_DIR` or `$XDG_DATA_HOME/devin/cli`, default `~/.local/share/devin/cli/sessions.db`). `devinSyncWorker` (`src/server/devinSync.ts`) mirrors visible sessions into `<dataDir>/devin-sessions/<id>.jsonl` in a Claude-shaped format, so the rest of the pipeline treats them like any transcript. It drops user rows that are not real user input (keepalive "continue" prompts, compaction requests).

It runs every `max(2000, AGENTBOARD_LOG_POLL_MS)` ms in both modes. Each cycle does the least work it can: if the database fingerprint is unchanged, the last full check is under 30 s old, and every mirror has its recorded size, it returns without opening SQLite. Otherwise it compares per-session row counts, appends new rows when the prefix is intact, and rewrites atomically (temp file plus rename) otherwise. The fingerprint (`src/server/devinDbFingerprint.ts`) includes the database header's change counter, the `-wal` header, and the `-shm` bytes, because a commit after a WAL reset can land inside the old WAL size within one mtime tick. An uncertain fingerprint counts as changed. `MIRROR_FORMAT_VERSION` forces a full rewrite when bumped.

## Enrichment

### Pull requests

`sessionMetadataWorker` extracts PRs from transcripts (`src/server/prExtractor.ts`), keyed by `(sessionId, logFilePath, agentType)` and retried with backoff from 1 s to 30 s (`src/server/sessionMetadataClient.ts`). It counts `gh pr create` only in command position of a real tool call, and attributes the URL through that call's tool result; for formats without call IDs it looks for the URL in the next 10 lines. It also counts a GitHub connector create call (`github_create_pull_request`, called directly or awaited in a straight line through Codex unified exec), and takes the PR only from that call's successful structured result, matched by call ID (`src/server/connectorPr.ts`); an ambiguous exec script is skipped. It also reads Claude `pr-link` records. Scans are incremental by byte offset. A file with a new device or inode, a shrunk file, or a same-size file with a new mtime or ctime is rescanned from the start. A byte prefilter skips records that cannot match (`prCreatePrefilter.ts`). A result holds PR descriptors only, and the client applies it only while the session's `(sessionId, logFilePath, agentType)` still equals the scanned one (`metadataIdentity`). A scan that finishes after a window moved to another conversation therefore cannot write the old conversation's chips onto it, and no result carries lifecycle fields. There is no synchronous fallback: when the worker fails, cached descriptors stay and a new worker starts after the backoff ([#426](https://github.com/gbasin/agentboard/pull/426)).

PR state comes from `gh pr view` (`src/server/ghRequestQueue.ts`, `src/server/prInfo.ts`): at most 4 processes, 128 distinct outstanding requests (more resolve to `null`), duplicates share one promise, 8 s timeout with SIGKILL, and a slot is held until the process and both pipes settle. Results are cached 60 s, up to 5,000 entries. The browser batches 8 URLs per request and runs one info request and one checks request at a time, with a 20 s abort (`src/client/lib/prMetadataRequests.ts`). The header comment there states the purpose: optional chips must not occupy the browser's connection pool.

### Media

`src/server/mediaExtractor.ts` finds images, documents, structured artifacts, and links in transcripts (Claude `image`/`document` blocks, Codex `input_image`, image generation, links in assistant prose via `replyLinks.ts`). `mediaDiscoveryWriterWorker` indexes them into `media-index.sqlite`; `mediaDiscoveryReaderWorker` serves pages from a read-only connection, so reads never wait on scans (`src/server/mediaDiscovery.ts`).

- **Scans** are resumable per file. A checkpoint records inode, size, mtime, and a SHA-256 of the first and last 256 bytes before the offset. An interior rewrite that also grows the file is not detected there; per-record digests on payload routes catch it at read time and force a reindex. Each step is one transaction with two targets, 1 MiB read and 12 ms (`mediaIndexWriter.ts`). Both are checked only after a complete record, so a step runs past them by up to one record (at most 64 MiB); a step can also stop in the middle of discarding an oversized record (`mediaIndexScan.ts`). One large record therefore makes a step run far past 12 ms, and the targets are not a scheduling guarantee. Page reads stay responsive because they run in the separate reader worker, not because steps are short (measurements in [#448](https://github.com/gbasin/agentboard/pull/448), [`docs/design/media-discovery/performance.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/design/media-discovery/performance.md)). Records over 64 MiB and descriptors over 16 KiB are skipped and counted, not truncated. Order time is a running maximum within a file, so a backward timestamp cannot reorder records.
- **Scheduling.** At most 32 started scanner jobs and 32 open media streams. A panel someone is viewing gets up to 4 slices before one background slice; unviewed dormant jobs are cancelled at their checkpoint.
- **When scans run** (`MediaDiscoveryClient.queue` and `watch`, `mediaDiscovery.ts`). Building a session view loads the stored summary from the index. It starts a scan only for a session with a live window, and only when the log size or the Codex link index changed or the last completed scan is 30 s old. The 30 s rule catches subagent growth and same-size rewrites, which the main log's size does not show. A dormant session is scanned only while a panel views it. A plain JSON `/items` request only reads the index; only the streamed form (`stream=1`) asks for a scan, and it asks every time a panel opens. A change that makes a page read start a scan breaks the rule that reads never wait on scans.
- **Pages** hold at most 40 items and 64 KiB (`src/shared/media.ts`), newest first. A cursor carries an ID watermark and the session generation: rows indexed after the first page stay hidden until Refresh, and a rewrite bumps the generation so old cursors fail with `STALE_CURSOR`. Lightbox neighbors read the live index, not the watermark. The discovery stream is NDJSON with 64 KiB frames, 512 KiB and 60 s per stream; when a stream ends before discovery is ready, the client continues it at most 3 times per open, then shows Retry; an error shows Retry at once (`useMediaPages.ts`). The client requests pages, neighbors, thumbnails, and originals only while the socket is connected and the terminal accepts input (the `ready` prop that `Terminal.tsx` passes to `MediaRail`). Recovery aborts those requests, so optional media never competes with a re-attach.
- **Payloads** (`src/server/mediaRoutes.ts`) are served only from the session's own transcript or its subagent logs. When the URL carries a digest, the record is checked against it; a digestless URL may address only items up to index 256. Only raster images, PDF, and plain text render inline; everything else is an `octet-stream` attachment. Payload responses carry a sandbox CSP and `nosniff`, and are cached `private, immutable` only when they render inline and the URL carries a digest; all others are `no-store` (`mediaPayloadHeaders.ts`). Thumbnail responses are PNG with `nosniff` and `private, immutable`, without the sandbox CSP. External media URLs are redirected (302, `http:`/`https:` only); the server never fetches them.
- **Thumbnails** (`mediaThumbnailDecoder.ts`, `mediaThumbnails.ts`) use pure-JS `pngjs` and `jpeg-js`, so the four compiled release targets need no native codec libraries. Limits: source 16 MiB, 16 megapixels, 16,000 px per side, output 128 px long edge and 128 KiB. Interlaced PNG is rejected; the comment in `mediaThumbnailDecoder.ts` records that pngjs's interlaced inflate path has no output limit. JPEG decoding runs with `tolerantDecoding: false` and `maxMemoryUsageInMB: 128`; that cap is the library's own allocation count, not a process memory limit, so an image under the pixel limit can still be refused. APNG (an `acTL` chunk), duplicate headers, and non-8-bit PNGs are rejected too. One decode runs at a time. At most 16 requests, counting the active decode, are admitted. When the active decode misses the 10 s deadline, it and every queued request are rejected, and new requests are refused until that decode finally answers; a decode that never answers disables thumbnails until restart (`mediaThumbnailClient.ts`). A worker error also disables them until restart; the cache is a 16 MiB, 1,024-entry in-memory LRU. The client loads thumbnails near the viewport only, 3 at a time.

Catalog messages carry media counts (`mediaSummary`), never descriptor lists (`src/server/catalogMessages.ts`). The same module truncates `lastUserMessage` to 250 characters on the wire. The catalog must stay small because the server sends whole lists: on every connection, after every reconnect, and again on every registry change, which broadcasts the full `sessions`, `agent-sessions`, or `agent-sessions-active` array (`src/server/index.ts`). On a slow link, lists that carry media descriptors can hold a pong back past the client's 10 s heartbeat deadline. The client then reconnects, and the new connection sends the same payload. In the reproduction, repeated update broadcasts caused the timeouts; the first snapshot alone did not. Treat every `Session` or `AgentSession` field as part of that budget: put collections behind a paged HTTP route, as media is, and put only a count or a bounded preview in the catalog. History is capped at 100 rows on the wire (`SIDEBAR_HISTORY_LIMIT`); live and hibernating sessions are not capped, so the catalog still grows with them. Reduce the size of messages, not their number: the client plays permission and idle sounds from each status transition it sees, and lifecycle result messages settle pending kills, wakes, and hibernates, so a sender that keeps only the latest message loses events. A reconnect gets a full snapshot on purpose; there are no per-client replay cursors. The measurement is in [#448](https://github.com/gbasin/agentboard/pull/448) ([`docs/design/bounded-session-catalog.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/design/bounded-session-catalog.md), [`docs/investigations/iphone-heartbeat/production-payload/README.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/investigations/iphone-heartbeat/production-payload/README.md)). It shows that reconnects depend on payload size on a shaped link; it does not give a safe size.

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
| `agentboard.log` | Logger (`src/server/logger.ts`); `LOG_FILE` moves it. Not always written: a source checkout in development mode with `pino-pretty` available logs to a file only when `LOG_FILE` is set. |
| `tmux-server.pid` | tmux server PID, written atomically by `SessionManager`; `AGENTBOARD_TMUX_PID_FILE` moves it. |
| `stall-samples/` | macOS `sample` reports, newest 20 (`src/server/stallWatchdog.ts`). |

Thumbnails have no disk cache. Temporary files live outside the data directory: `$TMPDIR/agentboard-upload-*`, `/tmp/paste-*`, and `$TMPDIR/agentboard-pane-*`.

### Main database

`agentboard.db` holds two families of tables:

- **`agent_sessions`**: one row per provider conversation (transcript). Key columns: `session_id`, `log_file_path` (both unique), `agent_type`, `display_name`, `current_window`, `is_hibernating`, `last_user_message` (clamped to 8,192 characters), `last_known_log_size`, `last_known_log_revision`, `slug`, `launch_command`. A row with `current_window` set is active. A dormant row (`current_window IS NULL`) is hibernating when `is_hibernating = 1` and history otherwise. An unexpected window loss hibernates; a deliberate kill moves to history. `is_hibernating` is a lifecycle marker, distinct from the catalog's user-facing `pinned`; a migration in `db.ts` renames the older `is_pinned` column to it. Startup never wakes a row whose catalog state is `hibernating`. With `autoResume` on, it does relaunch `interrupted` catalog rows, whose conversations have `is_hibernating = 1` because interruption hibernates them.
- **`app_settings`**: key/value. Keys include `tmux_mouse_mode`, `inactive_max_age_hours`, `prefer_window_name`, `terminal_colors_enabled`, `synced_settings.<key>`, `persistence_host_id`, `persistence_tmux_epoch`, `persistence_last_saved`, `persistence_settings`, and `catalog_schema_version`.
- The catalog tables in [Session-recovery catalog](#session-recovery-catalog).

`agent_sessions` has no version table. `initializeConnection` runs idempotent migrations that inspect columns with `PRAGMA table_info`, then creates indexes.

SQLite settings (`initializeConnection`, `src/server/db.ts`):

- `busy_timeout = 250` first, so the WAL switch also gets the short wait. bun:sqlite waits for locks synchronously on the main thread; a poll can issue about 25 writes; a longer timeout would freeze the server while another process holds the lock.
- `journal_mode = WAL`, so readers never block a writer. If the switch fails (an old server mid-write during an upgrade), the server stays on the current mode and converts on the next start.
- `synchronous = NORMAL` only when WAL took. NORMAL is safe under WAL and skips the per-commit fsync.
- `busy_timeout` caps lock waits, not write time. A WAL auto-checkpoint runs on the committing thread, so any main-thread write can still stall. Skip writes that change nothing, as `persistence_tmux_epoch` does.

Other connections: `sessionReadWorker` opens the database read-only (`query_only`, 2 MiB cache, `busy_timeout = 250`). Its results are hints; the main thread re-reads rows before it writes. `ownership.db` uses `busy_timeout = 1000`. The media writer connection on `media-index.sqlite` uses WAL and `busy_timeout = 5000`; the reader connection sets no pragmas.

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
- If `createWindow` fails, a fresh identity read looks for the tagged pane. If the pane exists, the row is bound to it at once. If it does not, the row becomes `failed`. If the identity read itself throws, the row stays `starting`, with its run open for a later reconciliation to adopt. No second process is launched.

**Reconciliation** (`PersistentSessions.beforeSnapshot` and `observe`, `manager.ts`) runs on every refresh against the refresh's own window list:

- An enumeration without a tmux server PID skips reconciliation, so an empty or failed listing cannot interrupt anything.
- Rows that look gone or retagged trigger one independent identity read for the batch (`confirmSnapshot.ts`). If that read fails or the epoch changed meanwhile, the whole pass aborts before any claim is released. An empty tag is unknown, never evidence of another owner.
- An active row with `requested_state` set: kill its tagged window, then move to that state.
- An active row whose run tag is live: bind it `running` and re-point its conversation at the window.
- An active row whose epoch differs or whose window is gone: `interrupted` ("Process stopped unexpectedly"). A definite tag mismatch: `interrupted` ("Window identity changed"). Its conversation's window claim is released only while it still points at this row's window.
- When the epoch changes, every `agent_sessions` window claim from the old tmux lifetime is orphaned.
- Reconciliation never kills an unexpected pane. `observe` adopts untracked managed windows as `discovered` rows, re-adopts `interrupted` and `failed` rows whose windows reappear, and never revives `hibernating` or `archived` rows. One failing session does not abort the pass.

**Stop and resume.** `stop` persists `requested_state` and an event before killing exactly the tagged run; a failed kill clears `requested_state`, so a later refresh does not kill silently. `resume` returns the live session when its run is still running, and refuses (409) while a launch is in progress, while the conversation belongs to another live board session, or while it still runs in another tmux session. Repeating a launch with the same `operationId` returns the live session or 409; it never launches twice.

**Paired writes.** The log poller writes `agent_sessions.current_window` for rows the catalog does not track (codex exec, discovered windows, rows not yet imported). The catalog and `agent_sessions` are therefore both written: a rename updates `board_sessions.name` and `agent_sessions.display_name`, and the rename goes to tmux before the catalog so a refused rename leaves no name the window does not have.

**Import.** `legacyImport.ts` imports `agent_sessions` rows without a catalog link, at most 100 per pass, never `codex exec` rows. The pass in the `PersistentSessions` constructor runs synchronously on the main thread; the pass after each `observe` reads its candidates through `sessionReadWorker`. A row whose window is in the managed session becomes `interrupted`; one running in another tmux session becomes `archived`; dormant rows map from `is_hibernating`.

**Settings** (`persistence_settings`, `settings.ts`). Two behaviours are opt-in and default off: relaunching sessions at startup and capturing terminal previews. Reconciliation and the import above run on every refresh and write catalog rows as needed, whatever the settings. `autoResume` reconciles once at startup, then resumes every interrupted row (`src/server/index.ts`). `capturePreviews` makes `PersistenceRuntime.tick` (`runtime.ts`, every `AGENTBOARD_PERSISTENCE_MAINTENANCE_MS`, default 5000 ms) capture up to 10 tagged windows per tick with `capture-pane -S -80`, keeping the last 32,768 characters with a timestamp. `GET /api/library/:id` returns the preview.

**Locks.** Two locks keep one server per database:

- `<dataDir>/server.lock` (`instanceLock.ts`) is a JSON PID file keyed on the data directory. Two servers on one data directory are unsafe because each reconcile loop treats windows it cannot see as gone. A lock is ignored when its PID is dead, is this process, or was written on another host.
- `<db>.recovery/ownership.db` (`ownership.ts`) holds an open `BEGIN EXCLUSIVE` transaction for the life of the process, keyed on the canonical database path (which `AGENTBOARD_DB_PATH` can move). The OS releases it on a crash. Connections in one process share it by reference count.

**Limits.** History pages hold 1–100 rows (default 50) with a keyset cursor; search also matches earlier names. A detail view returns the last 100 events. Previews of the last prompt are clamped to 8,192 characters. Nothing prunes catalog rows on a schedule; the only delete is in `associate`, which removes an imported duplicate when it merges into the row that owns the conversation (`catalog.ts`).

### Media index

`media-index.sqlite` is derived data: deleting it costs a rescan. Tables: `media_meta`, `media_sessions`, `media_files` (per-file checkpoints), `media_items`, `media_seen`. A session's identity is the SHA-256 of `[sessionId, logFilePath, agentType]`.

## HTTP and WebSocket surface

There is no authentication. An origin check (`src/server/requestOrigin.ts`) covers the `/ws` upgrade and every request whose method is not GET, HEAD, or OPTIONS. The relay worker checks `/ws`; the dashboard listener checks both, including the requests that the relay forwards with their `Origin` and `Host` intact. A request without an `Origin` header passes. A request passes when the host and port of `Origin` equal `Host`; when the server serves TLS itself, the `Origin` must also be `https`. An origin listed in `AGENTBOARD_ALLOWED_ORIGINS` passes. Everything else gets 403, including `Origin: null`. [SECURITY.md](../SECURITY.md) lists what the check does not cover. `/ws` is upgraded before Hono routing.

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

`GET /api/directories` accepts `path`, optional case-insensitive `query` (folder-name substring), and `hidden=false` to exclude dotfolders. Filtering precedes the 200-entry limit. Omitting `hidden` preserves the native client’s listing behavior. The web project field shows recent projects and completes server paths; Browse hides dotfolders by default and confirms only a successfully loaded, unedited path.

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

**Protocol version.** The client connects to `/ws?catalog=2` (`CATALOG_VERSION` in `src/shared/catalogProtocol.ts`). The version rides the upgrade URL because a server cannot renegotiate after it has sent its first snapshot. A socket with another version never joins the broadcast set: it receives an `error` reload notice every 4 s (`src/server/catalogUpgrade.ts`) and pongs, instead of a catalog it cannot parse or a close it would retry forever. A matching socket receives `server-config`, `sessions`, `host-status`, `synced-settings`, and `agent-sessions` on open. On the client (`useWebSocket.ts`), a first message other than `server-config`, or a `server-config` with another version, counts as a mismatch. The client then stops reconnecting and asks the user to reload. It never reloads the page itself, so text that was not sent yet and recovery drafts survive. It sends `terminal-resume` only after a matching `server-config`.

## Client

`src/client/main.tsx` mounts `App.tsx` and registers the service worker in production (`vite-plugin-pwa`, `autoUpdate`; the fallback excludes `/api` and `/ws`).

**Supported access path.** Reconnect and recovery must work in a Safari tab and in a Home Screen app over plain HTTP on a tailnet address. That path has no service worker (browsers run one only on a secure origin, and `main.tsx` registers it only in production builds) and no reliable background execution: iOS can suspend a page without delivering `pagehide`. Recovery code therefore runs in the page and treats lifecycle events as hints. Do not move reconnect, re-attach, or draft recovery into the service worker, and do not make them depend on a timer or an event that must fire while the page is hidden. The decision and its checks are in [#448](https://github.com/gbasin/agentboard/pull/448) ([`docs/design/bounded-session-catalog.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/design/bounded-session-catalog.md), [`docs/investigations/ios-resume-simulator/README.md`](https://github.com/gbasin/agentboard/blob/6ea2698/docs/investigations/ios-resume-simulator/README.md)). Those checks ran in the iOS Simulator over a loopback forward; a physical phone on Tailscale HTTP was not part of them. Loopback is a secure context, so a test over `localhost` or an SSH forward has the Clipboard API and never runs the `execCommand` copy fallback (`utils/copyTextWithResult.ts`). Test copy on the tailnet address.

- **Interface shell.** UI text uses the system sans-serif face; terminal text keeps its independently configured monospace font. Session rows share selection and focus styling across active, hibernating, and history lists. Prompt previews occupy one line on desktop and up to two on phones. Desktop toolbar buttons are 28 CSS px, shrinking only in narrow saved sidebars; the toolbar and status rail are 40 CSS px. The rail’s Session actions button exposes the existing context menu, including Kill Session and its confirmation, with keyboard navigation and focus return.
- **Stores** (Zustand, `src/client/stores/`). `sessionStore` holds live sessions, conversations (active, hibernating, history), host status, selection, and connection state; only the selection persists, under `agentboard-session` in localStorage behind a tab-scoped adapter that reads localStorage once and then serves this tab from memory (`createTabStorage`, `utils/storage.ts`). `settingsStore` holds UI and device preferences, persisted as `agentboard-settings` with a versioned `migrate`. `themeStore` holds the theme, persisted as `agentboard-theme`.
- **Synced settings** (`src/client/syncedSettings.ts`, `src/shared/syncedSettings.ts`). Keys in `SYNCED_SETTINGS_KEYS` (theme, command presets and the default preset, default project directory, last project path, recent paths, sort and manual order, sidebar anchor, project and host filters, list display options, sounds) are canonical on the server in `app_settings`. The server pushes the full set in `synced-settings`; local changes go out with `PUT /api/settings/synced` after 200 ms. Echoes are suppressed against the last confirmed value, and a key with a pending push keeps its local value.
- **WebSocket** (`src/client/hooks/useWebSocket.ts`). One `WebSocketManager` per document. It negotiates the catalog version, then sends `terminal-resume`. It pings every 20 s and declares the socket dead after 10 s without a pong that carries the ping's sequence number; other incoming messages do not reset the deadline. A pong waits behind catalog bytes already queued on the same socket, so do not raise `PONG_TIMEOUT_MS` to absorb large catalog frames: make the frames smaller (see [Media](#media)). A timeout while other messages still arrive does not prove a client timer bug, because a stalled uplink alone looks the same. Visibility change, `pageshow`, and a clock jump over 15 s trigger a 1.5 s verification ping; a healthy socket stays, and terminals re-attach. Reconnect backoff is exponential to 30 s and pauses while the page is hidden. Overload backoff (1 s doubling to 30 s) is separate and clears only after 30 s of verified, visible, attached use. Terminal frames for an old `attachId` are dropped but still acknowledged. A socket that the manager retires loses its open, message, and error handlers and keeps only a close observer that drops the reference, so a late event from it cannot change the status, the timers, or its replacement. The `leaked` number in client diagnostics counts retained JavaScript references (pending opens and retired sockets that have not closed yet), not open TCP connections ([#435](https://github.com/gbasin/agentboard/pull/435)).
- **Killed sessions and stale snapshots.** A refresh that started before a kill can finish after it and list the killed window. Two fences stop that list from restoring the session, and `session-removed` alone does not make later snapshots safe. On the server, optimistic registry changes (kill, create, resume) bump `refreshGeneration`, and an in-flight refresh that sees a newer generation discards its window list and retries (`src/server/index.ts`). On the client, `App.tsx` filters every `sessions` snapshot against `pendingKills`. An entry leaves that map only on `kill-failed` (which rolls the removal back) or when the connection epoch changes.
- **Terminal** (`src/client/hooks/useTerminal.ts`, `components/Terminal.tsx`). xterm.js 6 with `scrollback: 0` (tmux owns scrollback) and the fit, clipboard, search, serialize, progress, and web-links addons; WebGL is optional. Typing goes out as `terminal-input`, paste as `terminal-paste`. An attach goes out whenever the session, target, or connection epoch changes; switching sessions caches a serialised snapshot (up to 20) for an instant switch back. The client does not read the `retryable` field of `terminal-error`: after a failed attach on an open socket, the terminal stays not ready (and the media rail paused) until the user selects the session again or the socket reconnects. Output is acknowledged after the parser finishes. Two ordering rules hold here. First, `terminal-ready` from the server does not enable input by itself: the hook marks the session ready in the callback of a write queued behind the screen data, so input opens only after xterm has parsed that screen. Resets go through the same queue (`drainParserQueue`), because `terminal.reset()` is synchronous and `write()` is not; a reset issued ahead of pending writes would let the old pane paint over the new screen. Second, a paste that waits on asynchronous work (a clipboard read, or an image fetched from the host clipboard) is fenced by the parser generation and the connection epoch captured at the gesture, in addition to the session ID. A session ID repeats after a switch from A to B and back, or after a reconnect, so the ID alone would deliver the paste to an attachment that did not accept it.
- **Recovery drafts** (`hooks/useRecoveryDraft.ts`, `utils/recoveryDraftStorage.ts`). Text typed or pasted while a terminal is not ready, or while a draft is already pending, goes into a per-terminal draft in localStorage: at most 65,536 characters per draft and 128 drafts. It is never sent automatically. **Send text** delivers it as one `terminal-paste` without Enter, which is bracketed only when the pane's application enabled bracketed paste. The key includes the tmux server PID, and falls back to `createdAt` only when the PID is unknown.
- **Settings registry** (`src/client/components/settings/`). Each row is a `SettingsRowDef` in `rows/*.tsx`, collected into `SETTINGS_ROWS` (`registry.ts`). A page renders the rows whose `page` matches, and search runs over the same list, so a row is defined once. Server-backed rows use `useServerSetting`.
- **Sounds** (`src/client/utils/sound.ts`). See [notifications.md](notifications.md).

## When you add X, also change Y

| When you add or change | Also change |
| --- | --- |
| A Worker entry file | Add it to the `bun build --compile` entrypoint list in `.github/workflows/release.yml` **and** in the compiled smoke test in `.github/workflows/ci.yml`. Load it with `resolveWorkerPath`. A test (`src/server/__tests__/workerPath.test.ts`) checks only that both lists name the two media discovery workers. The CI smoke test compiles from its own list in `ci.yml`, so it cannot catch a worker missing from `release.yml`. |
| A server test that patches `Bun.serve`, `Bun.spawnSync`, `process.exit`, timers, or module-level config, or that imports `src/server/index.ts` | Add its file name to `ISOLATED_FILES` in `scripts/test-runner.ts`, or put it in `src/server/__tests__/isolated/` (each file there runs in its own process automatically). |
| A server test that starts real servers, PTYs, or tmux | Add it to `ISOLATED_REAL_TMUX_FILES` in `scripts/test-runner.ts`. These run without coverage and are skipped by `--skip-real-tmux` (`test:ci`). |
| A client test with a top-level `mock.module`, a replaced `document`, or anything that renders `motion/react` | Add it to `ISOLATED_CLIENT_FILES` in `scripts/test-runner.ts`. Module mocks and motion's frame callbacks leak into later files in the same process; failures then appear in unrelated files and depend on file order (Linux CI). |
| A test in a new directory | `scripts/test-runner.ts` runs `launchd/release.test.mjs` (with `node --test`), `scripts/verify-platform-lock.test.ts`, the globs `src/server/__tests__/*.test.ts`, `src/server/__tests__/isolated/*.test.ts`, and `src/client/__tests__/*.test.{ts,tsx}`, and the directory `src/shared/__tests__` (searched recursively). Other locations are not run. |
| A subprocess spawn | Pass `env` (`sanitizedTmuxEnv()`), or use `timedSpawnSync`/`timedSpawnAsync`. |
| A WebSocket message type | `src/shared/types.ts`. A terminal message handled by the relay also goes in two sets that must match: `TERMINAL_TYPES` (`relay/leases.ts`), which routes it to the lease worker, and `COMMANDS` (`relay/terminalRuntime.ts`), without which `TerminalRuntime.handle` ignores it. Then add its case to `TerminalRuntime.handle`. An incompatible catalog change bumps `CATALOG_VERSION` in `src/shared/catalogProtocol.ts`. |
| A synced setting | `SYNCED_SETTINGS_KEYS` and its validator in `src/shared/syncedSettings.ts`, plus the store field. |
| A settings row | A `SettingsRowDef` in `src/client/components/settings/rows/`, registered through `registry.ts`. |
| An agent type | The `AgentType` union (`src/shared/types.ts`), `src/shared/agentDetection.ts`, the `agent_type` CHECK in `src/server/db.ts` (a CHECK change needs a table-rebuild migration), the roots in `src/server/logDiscovery.ts`, the agent lists in `src/shared/syncedSettings.ts`, `src/client/stores/settingsStore.ts`, `src/client/components/AgentIcon.tsx`, `src/client/components/settings/presetEdits.ts`, and `src/client/components/SessionPreviewContent.tsx`, the resume command (a `*_RESUME_CMD` setting in `src/server/config.ts`, a branch in `getResumeCommandTemplate`, and the flag stripping in `buildResumeCommand`, both in `src/server/index.ts`; an agent type without a branch resumes with the Codex template), and the FAD parity fixtures (`AGENTS.md`). |
| An environment variable | [configuration.md](configuration.md), and usually `src/server/config.ts`. Several variables are read elsewhere: `AGENTBOARD_TERMINAL_RELAY` and `AGENTBOARD_STATIC_DIR` in `index.ts`, `AGENTBOARD_PERSISTENCE_MAINTENANCE_MS` in `persistence/runtime.ts`, `AGENTBOARD_TMUX_SET_CLIPBOARD` in `terminal/PtyTerminalProxy.ts`, `AGENTBOARD_TMUX_SYNC` in `terminal/TerminalProxyBase.ts`, `AGENTBOARD_RELAY_GRACE_MS` and `AGENTBOARD_RELAY_PROGRESS_MS` in `relay/leases.ts`, and `AGENTBOARD_DATA_DIR` also in `db.ts` and `devinSync.ts`. Grep for `process.env` before you assume one place. |
| A Devin mirror format change | Bump `MIRROR_FORMAT_VERSION` in `src/server/devinSync.ts`. |
| Thumbnail output | Bump `THUMBNAIL_VERSION` (`mediaThumbnailDecoder.ts`), which keys the server cache. Browsers cache thumbnail responses as `immutable` for a year by URL, so an incompatible output change also needs a new `thumbnail=` value in both clients (`hooks/useMediaThumbnail.ts`, `components/MediaLightbox.tsx`) and the server check in `mediaRoutes.ts`. The server treats only `thumbnail=1` as a thumbnail request; any other value silently serves the original payload. |
| Payload response headers or bytes behind an existing media URL | Bump the `delivery=` value in `src/client/utils/mediaPayloadUrl.ts`. Browsers keep inline payloads as `immutable`, and the server ignores the parameter, so a new value changes only the cache key. Media identities, neighbor anchors, and thumbnail URLs stay the same. |
| Anything, before commit | The pre-commit hook (`.githooks/pre-commit`; the `prepare` script sets `core.hooksPath`, and Bun's install documentation, `node_modules/bun-types/docs/pm/cli/install.mdx`, states that `bun install` runs the project's `prepare` script) runs `bun run lint`, `bun run typecheck`, and the full `bun run test`, including the real-tmux suites. |
