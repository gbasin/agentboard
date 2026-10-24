# Terminal relay integration

The public Bun listener runs in a Worker. It serves the existing `/ws` endpoint and proxies HTTP to a dashboard listener on an ephemeral loopback port. TLS terminates at the public listener. The optional Tailscale listener uses the same Worker and port; its successful bind is acknowledged before it is advertised.

Terminal traffic and ping/pong do not cross the dashboard event loop. Dashboard WebSocket messages cross a virtual-socket bridge. Only terminal identity fields cross the terminal-worker registry boundary; status and transcript updates do not trigger repeated catalog fanout. Each terminal lease gets a separate Worker because tmux observer creation and some existing terminal operations contain synchronous subprocess calls. A slow observer startup must not block an already attached sibling.

Only session identity (id, tmux target, host, remote flag) crosses into terminal realms. Status and transcript changes do not trigger relay catalog updates; unchanged identities are deduplicated after deterministic sorting. Terminal color setting changes still propagate.

A resume token is random, document-local, and independent of the observer ID used in tmux names and logs. Increasing claims fence old transports. Every attachment revalidates the actual tmux target; retaining an observer does not establish readiness. An immutable target/host identity fences input and output if the catalog changes after readiness. Old clients without the handshake attach lazily and dispose immediately on disconnect.

Leases expire after 90 seconds without client application traffic, including a silently suspended OPEN socket. Disconnected observers expire after 60 seconds. There are at most 32 worker realms, counting active, retiring, and reusable idle workers. `AGENTBOARD_RELAY_PROGRESS_MS` and `AGENTBOARD_RELAY_GRACE_MS` allow accelerated isolated tests. The limits bound retained observers, not agent lifetime. Disposing an observer does not kill its agent window.

New clients acknowledge terminal output after parser completion. Unacknowledged output is limited to 1 MiB; worker-to-listener output is limited to 2 MiB awaiting delivery credit. Outbound socket payload plus buffered bytes is limited to 16 MiB, including single dashboard frames. Overflow closes the transport and requires a fresh snapshot rather than discarding ANSI bytes and continuing. Legacy clients receive the socket bound without parser acknowledgment support.

## Bun worker retirement failure

On macOS with Bun 1.3.14, calling `self.close()` in the nested PTY Worker after successful observer disposal reproducibly killed the entire process with SIGTRAP, rather than emitting a JavaScript worker error. Three consecutive real integration runs failed during the second test after the first lease expired. The macOS report `bun-2026-10-24-152227.ips` recorded EXC_BREAKPOINT on a Worker thread. This extends the repository's existing warning that terminating Workers can crash compiled Bun binaries.

The implementation disposes the observer, waits for its acknowledgment, and reuses the now-idle realm. It never terminates PTY realms during normal service. Shutdown disposes observers and acknowledges to the parent, which owns process exit. A disposal deadline or unexpected worker failure fails the service instead of accepting new work with orphaned resources. Existing startup cleanup can reap obsolete grouped observer sessions after restart.

## Regression evidence

`terminalRelay.integration.test.ts` starts a separate dashboard process with an isolated tmux server and real PTYs. It checks terminal echo and ping during a 600 ms synchronous dashboard stall, echo while a sibling's tmux startup deliberately sleeps, retained target switching and stale attach IDs, eight consecutive legacy attach/dispose/reuse cycles, silent OPEN expiry, disconnected expiry, agent survival, and clean process shutdown. The first passing pool implementation completed five tests and 34 assertions. `terminalRuntime.test.ts` covers asynchronous ownership and catalog-remap fences using controlled proxy races.

Client lifecycle validation with WebKit and the remote iOS Simulator is tracked separately. Those environments do not reproduce every device OS suspension or Tailscale radio-transition behavior; physical-device validation remains useful.

## Compiled artifact check

The release build exposed a separate existing path bug: worker entrypoints are embedded as `/$bunfs/root/src/server/<name>.js`, while the main entry is renamed to the executable basename. The old `./<name>.ts` paths failed with `ModuleNotFound`. `workerPath.ts` now resolves the embedded paths for all worker clients. See [Bun's standalone worker documentation](https://bun.com/docs/bundler/executables#worker).

After building with the exact entrypoint list from `.github/workflows/release.yml`, run:

```
bun scripts/verify-terminal-relay-binary.ts /path/to/compiled/agentboard
```

The smoke test creates a private tmux server and data directory. It checks HTTP, real terminal attachment, retained reconnect with the same observer tty, input echo, expiry, surviving agent windows, worker-load errors, and clean shutdown. The macOS ARM64 binary passed this check with exit code 0 and no signal.

## Client recovery contract

Visibility restoration, persisted pageshow, and elapsed-time gaps share one verification path. A pending probe or connection attempt absorbs overlapping lifecycle signals. The first attempted terminal command also checks elapsed time, so input cannot race a delayed wake timer. Hidden pages stop heartbeats and detach streaming when their lifecycle event arrives.

A successful verification advances the connection epoch and requests a new terminal attachment. Server readiness alone does not enable typing: the xterm parser must finish the screen and a readiness barrier. Serialized writes and resets prevent an old parser callback from repainting a newly selected session. Attachment IDs reject old A frames after A-B-A switching. Parser acknowledgments carry a client-only epoch that the transport validates and removes before sending; a late callback cannot release a replacement socket's output budget.

Rejected input is not queued for replay. Clipboard reads and image-path resolution also capture the attachment generation and connection epoch; completing after A-B-A or reconnect cannot send a delayed paste into the replacement attachment. Four deferred clipboard/image regressions fail when those fences are removed. Resume tokens remain in document memory, so duplicated tabs and new pages cannot steal the original document's observer. A full page reload still restores the selected session through the existing selection state, then establishes a new lease.

The existing failed-probe timeout (1.5 seconds), network-settle delay (750 milliseconds), and attachment debounce remain. This change removes dashboard contention and unsafe recovery races; it does not promise instantaneous recovery when a network path is dead.

## Validation commands

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bunx playwright test --config playwright.resume.config.ts
AGENTBOARD_TERMINAL_RELAY=1 bunx playwright test --workers=1 --retries=0
```

The resume matrix runs Chromium and WebKit against the integrated relay and real isolated tmux panes. It exercises held/dropped verification replies, rejected typing and paste, offline/reload, overlapping lifecycle events, and stale readiness during A-B-A switching. Chromium additionally suspends only its test-owned renderer processes with SIGSTOP/SIGCONT and verifies that their timer counter stopped. CDP lifecycle freezing was rejected as a suspension simulation because the counter continued running in this setup. WebKit skips that Chromium-specific test.

The new recovery case failed against the unmodified base version before passing on this implementation. CI runs the resume matrix on Linux and the real relay lifecycle plus release-style compiled-binary smoke on macOS. Native iOS Simulator evidence and its separate limitations are recorded in [ios-resume-simulator](ios-resume-simulator/README.md).

## Recorded results (2026-10-24)

The checked source suite passed 2,002 Bun tests, plus the repository's Node test stage. Lint and typecheck passed; lint retains one pre-existing empty-fixture-pattern warning in `websocket-recovery.spec.ts`. The release-style macOS binary passed HTTP, real PTY attach, same-observer reconnect, input echo, lease expiry, agent survival, and clean shutdown.

The existing E2E suite passed all 98 tests with the relay enabled, one worker, and no retries (5.3 minutes). A preceding parallel run passed 92 and failed six; five failure cases passed when rerun serially. The recovery-notice case also needed to wait for its WebSocket connection before externally broadcasting a library change. CI now serializes the shared application/catalog/tmux fixture suite. Local parallel execution remains available, but it is not the validation baseline.

The final rebuilt Chromium/WebKit resume matrix passed all 13 runnable cases without retries (55.5 seconds); WebKit skips only the Chromium renderer-process suspension case. The recovery-notice check also passed independently after changing its connection wait to work with either the Tailscale button or plain connection indicator. Successful screenshots show the real pane echo before and after verified recovery, with no rejected input marker.

The native remote iOS run delivered all 11 expected markers exactly once to their intended panes. Safari and Home Screen mode survived 45-second background intervals; the Home Screen app also restored its selected B terminal after termination and relaunch. The simulator, probe server, tunnel, and private tmux fixtures were stopped after evidence capture.
