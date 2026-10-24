# Multi-view terminal sizing probe

Run: `bun .poc-stress-test/sizing/probe.ts`

Environment: macOS ARM64, Bun 1.3.14, tmux 3.7b. Real terminal relay Worker, real per-lease PTY workers, real private tmux server, one cat pane, two WebSocket clients. Probe creates its own temporary TMUX_TMPDIR, removes inherited TMUX/TMUX_PANE, starts tmux with `/dev/null` config, and cleans only its own named sessions. It never accesses the production tmux socket.

| Claim | Evidence | Status |
| --- | --- | --- |
| A retained hidden phone can affect desktop dimensions | Desktop160x50 + phone40x20; phone `terminal-detach` retains40x20 | POC-confirmed |
| Default latest lets next desktop input restore width | First desktop input after phone detach restores160x50 | POC-confirmed |
| smallest policy remains constrained by hidden phone | Switching isolated pane window-size to smallest constrains40x20 while phone retained | POC-confirmed |
| ignore-size releases constraint without worker/PTY destruction | `refresh-client -t <phone tty> -f ignore-size` restores160x50 under both latest and smallest; phone tty remains attached | POC-confirmed |
| Foreground restoration can regain phone sizing | Clear ignore-size then fresh terminal-attach ->40x20 | POC-confirmed |
| Lease expiry removes constraint | Accelerated grace800ms; after2.6s phone observer gone and desktop160x50 restored | POC-confirmed |
| Reopen after expiry gets a new lease | Token differs; phone fresh observer40x20 | POC-confirmed |

Current implementation `TerminalRuntime.suspend` only revokes readiness/session identity and stops clipboard polling. It leaves the terminal PTY attached. `PtyTerminalProxy.doStart` uses plain `tmux attach -t`; its client feature args are only `-T sync`, not sizing flags. `resize` changes the attached PTY's dimensions. There is no `ignore-size` flag or window-size override in that path.

Local tmux manpage describes `ignore-size` as excluding a client from other clients' sizes, and `refresh-client -f` can set/toggle client flags; leading `!` clears a flag. `window-size latest` chooses the most recently active client; smallest chooses the smallest attached session. Primary online reference: https://man.openbsd.org/tmux . Exact installed manual inspected with `man tmux | col -bx`.

No policy was implemented. A potential minimal behavior is to mark suspended observers ignore-size and remove that flag only on a current, verified foreground attach. Parent must trace async resume/suspend ordering and user sizing preference before implementing it. Existing server lifetime/target fences alone do not serialize a new asynchronous size-flag mutation.

Raw output: output.log; machine-readable snapshots: results.json. Intermediate initial run waited only1.3s for800ms-grace expiry, which was insufficient due sweep scheduling; final run waits2.6s and confirms disposal. All fixture processes and private sessions exited cleanly.

## Implemented follow-up

Relay-created PTY/SSH clients now start with ignore-size, then enable sizing only during a current foreground attach. Suspend queues ignore-size asynchronously. The proxy serializes flag transitions and disposal drains the queue before releasing its tty. Pipe-pane has no client-size flags. The final real probe confirms automatic restore to160x50 on phone detach and socket disconnect; it previously remained40x20. `fixed-output.log` and `fixed-results.json` preserve that run. Unit suites cover late startup, rapid hide/show, pending mutation disposal, dead/replaced tty, remote dispatch, command retry, and readiness gating.

Compatibility: releasing a background observer's size requires tmux 3.2 or newer. The proxies gate both initial `-f ignore-size` and later `refresh-client -f` against the running server version, independently of synchronized-rendering configuration. Local startup obtains `#{version}` in the existing status-setting command; SSH obtains it from session creation, or its existing duplicate-session fallback query. Older or unknown versions attach normally and retain their previous sizing behavior. This avoids breaking attachments on supported older tmux installations. The upstream [3.2 new-session command](https://github.com/tmux/tmux/blob/3.2/cmd-new-session.c) accepts `-f`; [3.1c](https://github.com/tmux/tmux/blob/3.1c/cmd-new-session.c) does not.
