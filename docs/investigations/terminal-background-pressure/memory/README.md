# Terminal worker memory and signal investigation

This directory preserves isolated probe sources and compact evidence from macOS/Bun 1.3.14. No production sessions were used. Fixtures remove inherited TMUX, use private tmux/data/transcript directories, and delete only their own sessions. They never invoke kill-server.

## Memory result

The direct relay fixture measured external process RSS, worker counts, observer counts, and echo behavior. The 146-second sequence covered 20 retained reconnects, six concurrent attached terminals, expiry, 60 expired-lease reuse cycles, and 60 seconds of final idle. Workers stayed bounded at six; expired observers disappeared; all echo checks passed. This finite run does not establish an overnight leak bound or measure full physical footprint.

Before lazy allocation, six dashboard-only resume handshakes allocated six worker realms and increased RSS from approximately 30 MiB to 115.3 MiB without any PTY. After lazy allocation, six handshakes allocated zero workers and RSS was approximately 32.5 MiB from a 30.7 MiB baseline. Only a valid terminal attach now allocates a realm. The full churn run ended around 35.3 MiB after the change versus 33.9 MiB before. No monotonic growth was observed.

`samples.json` and `before-samples.json` preserve full sequences. `handshake-samples.json` and `before-handshake-samples.json` preserve dashboard-only controls. The fixture has terminal workers directly below its main realm; full application RSS includes additional application workers and is not directly comparable.

## Shutdown defect and fix

Concurrent macOS PTY spawn caused the main thread's native SIGTERM mask to change from unblocked to blocked. Its signal handler address stayed unchanged and its heartbeat continued. A diagnostic native unblock restored delivery. Serializing synchronous PTY spawn across workers preserved the unblocked mask. Serializing worker startup alone did not work.

The actual compiled application without the mutex failed SIGTERM's ten-second deadline in `compiled-regression.txt` and `compiled-negative-repeat.txt`. The same extended smoke passed three consecutive times with the mutex in `compiled-mutex-{1,2,3}.txt`; source mode passed twice. These results reduce the demonstrated risk; they are not proof against every runtime failure.

Six real concurrent attaches measured native spawn durations 30.75–35.44 ms and maximum queue wait 139.77 ms (`pty-durations.jsonl`). Retained reconnects do not spawn and do not take this lock. See [the implementation rationale](../../pty-spawn-signal-mask.md) for primary Bun source links, scope, and limitations.

## Reproduce

The archived scripts retain their original repository-relative paths. Copy this directory's TypeScript and C files into `.poc-stress-test/memory/` before running them from the repository root. Build the diagnostic C library:

```sh
cc -dynamiclib .poc-stress-test/memory/signals.c -o .poc-stress-test/memory/signals.dylib
CASE=negative PRETTY=0 bun .poc-stress-test/memory/signal-run.ts
CASE=serialized PRETTY=0 LOCK=1 bun .poc-stress-test/memory/signal-run.ts
```

The minimal runner signals its own child after four seconds, allows three seconds for exit, and force-kills that child on failure. Its sleep children live at most five seconds. The native diagnostic library is never used in production.

For the integrated compiled regression, build the normal release binary and run `bun scripts/verify-terminal-relay-binary.ts /path/to/binary`. That script checks real terminal echo, retained reconnect, six concurrent observers, expiry, idle pool, and bounded SIGTERM shutdown. The checked-in mutex tests cover exclusion, release after native failure, bypass for non-PTY subprocesses, main-thread rejection, and timeout without unlocking another owner.
