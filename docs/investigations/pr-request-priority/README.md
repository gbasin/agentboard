# Media blocked behind sidebar PR requests

The user reported “Loading media…” for more than 20 seconds in Safari on M5P, after reloading the 4040 build. That label means the Media fetch has started but no usable page has reached the component. It does not mean thumbnail generation or full transcript indexing is still required.

## Evidence and scope

The reported session's indexed API returned 40 items in 6–92 ms locally. A fresh WebKit page received the first streamed page in 103 ms; Chromium in 28 ms. A separate request from M5P returned headers in 379 ms and completed in 1.24 seconds. We did not capture the original Safari network request, so the historical request's exact cause remains unproven.

A separate shipped defect reproduces the same symptom. Each mounted PR chip initiated a distinct `/api/pr-info` fetch. On HTTP/1, six slow requests occupied the browser connection pool. Media queued in the browser before reaching its independent server reader. WebSocket traffic continued on its established connection. This explains why a direct API probe and a working terminal were insufficient validation.

The negative control used the actual `PrChips` and `MediaRail` from commit `db30953`, 18 synthetic PRs, real HTTP requests, and an eight-second response delay per PR. It did not intercept browser requests. Both Chromium and WebKit still displayed “Loading media…” at 20 seconds, with zero Media requests at the server and a successful WebSocket pong. Media appeared after 24.43 seconds in Chromium and 24.03 seconds in WebKit. See `old-build-reproduction.json`.

## Fix

The client coalesces same-turn requests into batches of up to eight URLs. Only one metadata batch and one hover-check request run at a time. Each dispatched request has a 20-second abort deadline. Duplicate callers share queued/running work, including hover cards mounted after a request began.

The server admits at most four actual `gh` processes and 128 distinct outstanding requests. Duplicate jobs share one promise. Timeout kills retain admission until the process and both pipes settle. Subprocess environments are explicit and stderr is drained. Combined metadata caches are capped at 5,000 entries.

These are limits on PR work, not a claim that every HTTP connection in the application is globally scheduled.

## Validation

- 2,283 tests pass; lint and typecheck pass.
- 28 targeted Chromium/WebKit E2E cases pass without retries: PR chips, historical PR links, progressive Media, Links pagination/search, and full-URL copy/focus.
- `bun scripts/verify-pr-request-priority.ts` holds one actual metadata HTTP request and one hover-check request open. The Media tile appears before either is released: 120 ms in Chromium and 49 ms in WebKit in the measured run. WebSocket ping/pong also succeeds. All 18 PRs resolve afterward in batches of 8, 8, and 2.
- The new real-HTTP regression is wired into CI after browser installation. It asserts readiness while metadata remains blocked, not a fragile millisecond threshold.
- The production build and compiled media/terminal smoke scripts pass, including clean shutdown and retained terminal recovery.

The prior media tests had no slow sidebar PR traffic. Their success established media/index correctness but did not cover browser connection contention. This regression closes that specific coverage gap.

Claude critique `20261026-115938-claude-812dbe61` found no correctness blocker in scheduling, settlement, timeout ownership, or result delivery. Material claims were checked against source and the completed tests. The review did not run tests itself.

## Tradeoffs

PR badges and hover details can fill in gradually when GitHub is slow. A hover check queued behind slow server work can exceed its client deadline; reopening retries, and completed server results remain cached. Existing unavailable-result caching remains 60 seconds, including capacity rejection. Per-row periodic refreshes are bounded but may produce several one-URL batches rather than one combined batch. None occupies all six browser slots through PR work alone.

This reproduction demonstrates a real cause of the same symptom, not definitive attribution of the user's original request. Physical cellular performance is not inferred from these local tests.

## Controlled rollout

Deployed runtime commit `2070dc9` to 4040 on 2026-10-26. Candidate SHA-256: `5262eddfee9b29234fd970f46153171f6c222ef596e99efde7dfada9dbc0743c`. All 27 prior tmux panes remained present. The served HTML matched the prepared release. The prior release is retained for rollback.

A live indexed snapshot arrived in 219.9 ms immediately after startup; all 15 heartbeat replies arrived, with maximum local round trip 62.4 ms. Real thumbnail, neighbor round-trip, Links search, and Tailscale HTTP checks passed. These startup measurements are not browser connection-contention timings or cellular guarantees.

Existing tabs must reload to get the client-side request budget. A terminal reconnect alone retains the old JavaScript. The clean followup worktree is retained while its PR is unmerged.
