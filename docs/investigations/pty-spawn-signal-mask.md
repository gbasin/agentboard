# Concurrent PTY creation and shutdown signals

On macOS with Bun 1.3.14 (`0d9b296a`), concurrent `Bun.spawn({ terminal })` calls from six workers can leave the main thread unable to receive SIGTERM or SIGINT. The application remains responsive to HTTP requests. This occurs in source mode and was also observed in a release-style compiled binary.

A minimal reproduction uses six workers, each spawning `/bin/sleep` with a PTY, and a parent SIGTERM listener. A native diagnostic queried `pthread_sigmask` and `sigaction` on the parent thread. SIGTERM starts unblocked and becomes blocked after concurrent PTY creation; the installed handler address remains unchanged. A one-second heartbeat continues after the signal. Explicitly unblocking SIGTERM restores delivery. This diagnostic uses FFI only in the investigation, never in production.

The matching [Bun 1.3.14 native spawn implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/bindings/bun-spawn.cpp#L142) blocks signals with `sigprocmask` around `fork` and restores the previous mask afterward. The [macOS dispatch path](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/runtime/api/bun/spawn.zig#L338) sends only PTY spawns through this custom fork implementation; ordinary subprocesses use the system `posix_spawn` fast path. This supports the observed failure mechanism; the precise upstream race has not been independently confirmed by Bun maintainers.

Controls that pass include one PTY worker, six workers without PTYs, and serializing the synchronous PTY spawn calls. Re-registering the signal listener, registering listeners in workers, removing logging, and leaving the PTY open do not fix the failure. Serializing worker module startup alone also does not fix it.

## Workaround

The relay shares one `SharedArrayBuffer` with all terminal workers. On macOS, the workers acquire an atomic mutex only while calling the synchronous native PTY spawn function. Both local and SSH proxies receive the same wrapper. The lock is released in `finally`, including native spawn failures. No network operation, await, terminal output, retained reconnect, or tmux setup is inside this critical section. Non-PTY subprocesses bypass it.

The main thread cannot use this blocking wrapper. A worker stops waiting after five seconds and fails the attachment without unlocking another worker's lock. A worker that dies while holding the mutex can prevent subsequent attachments; the relay already treats worker failure as fatal. The timeout prevents an unbounded wait but does not repair a dead owner.

Six simultaneous real application attachments measured native spawn durations of 30.75–35.44 ms and lock waits of 0.004–139.77 ms. This serial startup cost applies to newly created terminal observers. Reconnecting to a retained observer does not spawn a process.

## Regression checks

`ptySpawnLock.test.ts` checks mutual exclusion across six real workers, release after spawn failure, non-PTY bypass, rejection on the main thread, and timeout without releasing another owner's lock. `verify-terminal-relay-binary.ts` exercises real terminal echo, retained reconnect, six concurrent observers, observer expiry, and a ten-second shutdown deadline. It reports failure if SIGTERM requires forced cleanup.

Keep the workaround until a newer Bun runtime passes the same concurrent PTY and bounded shutdown tests. In this investigation, the workaround passed two source-application runs and three consecutive compiled runs. The same compiled scenario without it failed twice. A passing single run is insufficient: compiled failures were intermittent before serialization.
