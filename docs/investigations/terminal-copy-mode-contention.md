# Copy-mode polling blocks unrelated terminals

## Scope and production evidence

Investigated the deployed 0.34.2 terminal path on 2026-10-15, using its
watchdog samples, timestamped logs, and source at f528165. No production
restart, instrumentation, load generation, or workload shutdown was used.

The 19:26:41.189Z `terminal_attach_profile` reported capture=221ms,
switch=970ms, total=1191ms. That record lacks enough correlation to assign
its entire duration to a particular operation. The 19:20:49 watchdog sample
started at 19:20:52.543Z, after much of the triggering stall; most main-thread
samples were already waiting in kevent. Neither establishes a single cause.
Another sample includes SQLite reads, so database stalls remain a separate
possible contributor, outside this change.

The copy-mode handler independently exposes a blocking path: the browser
sends `tmux-check-copy-mode` immediately after attach and every 750ms. The
local handler synchronously executes `tmux -u display-message` with a 5s
timeout. Logs show that signature taking 537ms at 19:23:02.116Z and 531ms at
19:43:23.025Z, plus aggregated occurrences. The source identifies this as
an operation that can prevent the main thread from serving unrelated input.
These observations justify testing this mechanism, not attributing every
production stall to it.

## Actor state walkthrough

Before: browser A is attached and ready. Browser B requests another pane,
then its mode status. B's attach awaits asynchronous tmux work; its status
handler enters a synchronous child wait. A sends input, but server callbacks
cannot process it. A health request also waits. The child exits; the main
thread resumes; input reaches the PTY, output travels over WebSocket, and
xterm renders it. B's attach can also continue.

After: both attach and mode reads yield while waiting for children. A's input,
PTY output, WebSocket delivery, and DOM update proceed while B's mode query
is pending. B's history and ready message can arrive independently. A mode
reply is published only if the socket remains open and its captured attach
generation still matches. Within that generation, an older completion cannot
replace a newer completed read. A newer *pending* poll does not invalidate an
older result, avoiding starvation when query latency exceeds 750ms. Failed
reads retain the existing all-false fallback unless their result is stale.

## Controlled experiment

`playwright.contention.config.ts` creates a private tmux/data/provider setup
and puts a command wrapper on that server's PATH. It holds exactly one
selected pane's three-flag query for 1200ms. Other tmux commands go directly
to the private server. Two real browser pages use real WebSockets, PTYs,
shells, and xterm DOM rendering. The test enters a command whose output token
cannot be satisfied by the input echo. It asserts that the other terminal's
output, a health response, and the selected pane's content appear before the
held query is released. It also checks terminal-ready and mode-status frames.

This is an ordering regression, not a throughput benchmark or a simulation
of all macOS contention. It holds the child dependency fixed to test whether
one wait blocks unrelated work. Host workloads continued normally.

Three repetitions on unchanged code failed; three with the fix passed:

| Observed interval (ms) | Before | After |
| --- | --- | --- |
| Input action to observed rendered output | 1905, 1900, 1902 | 64, 152, 171 |
| Health request to response | 1293, 1274, 1325 | 316, 316, 317 |
| Switch action to observed target content | 2036, 2036, 2040 | 200, 296, 305 |

DOM observations use Playwright assertion polling and are upper bounds, not
precise paint timestamps. Switch content was checked after the other terminal
output, so that interval is also an upper bound. WebSocket output arrival and
query release timestamps are attached as JSON. A separate baseline run
sampled only the private Bun PID: all 842 main-thread samples were in a
kevent wait beneath unsymbolicated Bun frames. This is consistent with the
held dependency but cannot identify the JS callsite on its own. The explicit
fault gate, source path, and before/after intervention establish causality.

## Reproduction and limits

Build with `bun run build`, then run:

```
env -u TMUX bunx playwright test --config playwright.contention.config.ts
```

Use `--repeat-each=3` for repetitions. On macOS, `AB_PROFILE_SAMPLE=1` adds a
one-second sample of the private test server. Keep profile runs separate from
timing comparisons. The test attaches its timeline, screenshot, and server
log; teardown removes its private resources. It refuses to reuse an existing
HTTP server. CI runs the dedicated regression separately from the main E2E
suite.

The change does not remove OS scheduling delays, slow database writes, other
synchronous operations, or delays within tmux itself. It removes the main
thread's synchronous wait for this status query. No production improvement
has been measured after deployment because this change has not been deployed.

## Functional validation and review

- Lint, TypeScript checking, and the complete test runner passed (1,875 Bun
  tests, plus the release-script Node tests).
- Existing browser tests passed: application mouse handling and forced local
  selection (2), Claude/Codex discovery and full-message refresh (2), and
  hibernation under new log activity with a matching unclaimed window (1).
- The final isolated contention configuration passed again after review.
- Unit tests cover flag parsing, failure fallback, reversed completion order,
  slow-poll progress, and generation/disconnect invalidation. Handler tests
  verify grouped-pane targeting, asynchronous delivery, and actual detach
  invalidation.
- Independent subagent review found test-fixture compatibility, accidental
  server reuse, and missing CI/report configuration issues. These were fixed.
  Its follow-up found no application correctness defect. This is a review of
  the implementation and evidence, not independent production validation.
