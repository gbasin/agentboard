# WebSocket recovery observations (2026-10-19)

## What the production logs establish

Between 18:48 and 18:58 UTC, a browser connected through the Tailscale address,
repeatedly opened a WebSocket, then logged missing application-level pongs.
Many open-to-timeout intervals were about 50 seconds; others were about 30,
90, or 110 seconds. No corresponding server event-loop stall was logged.
The logs lack a browser/connection correlation ID and ping sequence details,
so they cannot establish which transport direction failed or whether timer
suspension or a stale pong was involved. Server receipt timestamps can also
lag browser events because client logs travel over HTTP.

The `leaked` counter increased to 10. This is a Set of JavaScript references,
not an operating-system count of open connections. Reading the implementation
showed that every retired socket is added to the Set and its close handler is
removed. Completed closes therefore remain in the Set until forced recovery.
Successful replacement opens remove only the replacement, not its predecessors.
A failed opening also remained tracked after its normal close event.

## Concrete state trace

Before:

- `manager = {ws: A, tracked: {}, status: connected}`.
- A misses a pong. Destroy detaches all A handlers, calls close, and sets
  `manager = {ws: null, tracked: {A}, status: reconnecting}`.
- Browser finishes closing A: `A = CLOSED`. No observer removes A.
- B opens: `manager = {ws: B, tracked: {A}, status: connected}`.
- Repeat twelve times: `tracked` retains twelve CLOSED sockets despite successful
  reconnects. The count misleadingly suggests unresolved connections.

After:

- Retiring A detaches its message/open/error handlers and leaves only a close
  observer that removes A from tracking.
- `A = CLOSING` remains tracked while awaiting confirmation.
- B opens and becomes authoritative. A's later close removes only A; it cannot
  change status, timers, or B. A captured stale message callback is ignored.
- Already-CLOSED sockets and synchronous close completion release immediately.
- Failed openings remove their reference on the normal close path.

The browser owns TCP teardown. The [WebSocket standard](https://websockets.spec.whatwg.org/)
specifies that close() does nothing for a CLOSING or CLOSED socket. Repeated
close calls cannot guarantee destruction of a stuck network connection.

## Bounded change

Release completed references and ignore stale message callbacks. Keep heartbeat,
verification, reconnect, cooldown, and visibility policies unchanged.
Add a per-manager trace ID, connection epoch, ping sequence, last received pong
sequence, last-message age, and visibility to existing WebSocket diagnostic
snapshots. These are metadata only, with no new periodic log event or payload
content. This will distinguish browsers and whether traffic continued while a
particular pong went missing. It does not itself explain the original timeout.

## Validation

Four focused regressions fail against the original implementation: completed
close cleanup, late old-socket events, repeated missed-pong recovery, and failed
opening cleanup. All 70 manager tests pass with the fix.

The browser regression forwards real application/server traffic and deliberately
drops pongs. It advances browser time through heartbeat deadlines, checks three
reconnects reattach the same terminal, and asserts completed socket references do
not accumulate. Restoring pongs is a positive control: reconnection stops.
All backend processes and tmux activity use the isolated E2E setup.

The same browser test fails against the original production build on the second
missed-pong cycle: retained count is 1 where the regression requires 0.
