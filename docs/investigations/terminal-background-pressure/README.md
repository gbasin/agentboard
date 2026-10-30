# Background terminals, overload, and recovery drafts

This follow-up applies the selected behavior: backgrounded phones release sizing to active views; deliberate text entered during recovery stays available for review and never sends automatically.

## Changes and evidence

| Concern | Change | Evidence |
| --- | --- | --- |
| Retained phone shrinks desktop | Start relay observers with tmux `ignore-size`; suspend queues exclusion; current foreground attach awaits inclusion | Real tmux desktop 160×50 / phone 40×20 probes, both `latest` and `smallest`; two-view Chromium/WebKit tests restore desktop width without desktop input |
| Dashboard tabs create unnecessary workers | Allocate worker only on a validated terminal attachment | Six token-only tabs: 115 MiB before, 32.5 MiB after; zero workers/PTys after change |
| Repeated overload reconnects every second | Preserve 1/2/4/8/16/30 s overload cooldown until sustained verified health | Real output with ACKs withheld; Chromium and WebKit recover and deliver final marker exactly once |
| WebKit strips close1013 | Send a bounded application overload notice before closing | Native WebSocket WebKit reports 1005 but respects 1004/1999/4006 ms retry floors |
| Obsolete output failure closes new owner | Fence worker overflow notifications by connection epoch | Regression delivers old overflow after replacement, verifies replacement remains usable |
| Text disappears during recovery | Capture printable typing/plain paste in per-terminal review draft; explicit send only | Hook/component tests; Chromium/WebKit switch-away/back and no-auto-send tests; native iOS server-stop/restart test |
| Concurrent PTY workers break shutdown | Serialize only native PTY creation on macOS | Matched compiled failure without mutex; three compiled and two source passes with mutex; see [runtime investigation](../pty-spawn-signal-mask.md) |

Background sizing release requires tmux 3.2 or newer. The final gate checks the running server version, including when synchronized rendering is disabled. Older/unknown versions omit the unsupported flags and retain previous sizing behavior rather than failing attachment. This adds no normal-path process or SSH round trip. After this compatibility change, root reran all four Chromium/WebKit two-view sizing cases successfully; 70 focused proxy/compatibility tests also passed.

The finite memory soak used 20 retained reconnects and 60 expiry/reuse cycles. Worker realms stayed bounded at 6, observers returned to 0, and RSS returned near baseline after 60 seconds idle. This does not establish overnight memory behavior. The pool still retains worker realms because Bun 1.3.14 crashes when those PTY worker realms terminate.

## Draft behavior and boundaries

Drafts are scoped to the physical window: session/window ID, tmux target, host, local/remote identity, and tmux server PID. Older servers without a PID use creation time as a conservative fallback. Late board/run tags and renames do not orphan them. Native testing caught that createdAt is a backend fallback timestamp when tmux omits window creation; restarting the backend changed it and hid a still-saved draft. The final key ignores createdAt when the tmux PID is known. A regression changes that timestamp while preserving the physical window. Readiness, visibility changes, and selection changes never submit them. While a draft is pending, further typing extends it. Only Send text delivers one bracketed paste; it adds no Enter. If the transport rejects that send, the draft remains.

Control sequences and file/image uploads do not become drafts. Existing async clipboard work is canceled across recovery generations. Mobile users can reopen the keyboard during recovery while command/file controls remain disabled.

Drafts now persist in local browser storage, following the user’s explicit preference. Reloading or recreating a document restores them for review, never for automatic sending. Normal writes and restoration are bounded to 65,536 UTF-16 code units and 128 records. Truncation remains visible even when another terminal consumed the budget. Excess imported records stay on disk; the selected identity gets priority, and the user can explicitly discard other drafts.

Each terminal has its own versioned record. Writes read the latest value; stale editor replacements produce a visible conflict with the local version retained. Storage events refresh without writing snapshots back. A tab cannot silently resurrect a record another tab discarded. Concurrent same-terminal editing is not a transactional collaborative editor: conflicting local text requires an explicit Save this version choice.

If storage is unavailable, the text remains in memory with a warning. If an accepted terminal send cannot remove its saved copy, the UI disables sending that copy again and offers cleanup. Clearing browser site data still removes saved drafts; different origins or browser storage containers do not share them. No expiration is introduced. A successful send means the WebSocket accepted the message; terminal input still has no application-level execution acknowledgment.

Actual app review edits in headless Chromium measured native localStorage.setItem at 0–0.1 ms for small text and 0–0.2 ms near 63,000 characters (20 samples each). These timings exclude JSON processing, React rendering, and physical-device storage behavior; they are not an iPhone latency claim. Normal live typing without a pending draft does not write draft storage.

Native iOS 26.4 tests ran only on the remote `macbook-m5p`, using a dedicated iPhone 17 Pro simulator. Both already-open and initially closed keyboard paths were tested. Root independently captured tmux before explicit send and after background/resume: zero marker before send, one afterward. The closed-keyboard harness initially tapped a clipped toolbar button; scrolling it fully into view made the native tap work. See [native evidence](ios/README.md).

## Validation

Root ran the final recovery suite against real tmux and both browser engines: 23 passed, with the Chromium-only renderer-freeze case skipped on WebKit. `browser-recovery-final.txt` preserves that run, including persistent reload/new-document/cross-tab deletion and changing discovery timestamps. Earlier runs remain as historical evidence. Native recovery checks, screenshots, state traces, and focused POC data are included here. The rebuilt broad browser suite passed 98/98 in 5.1 minutes (`browser-regressions-final.txt`). Before the final compatibility guard, the source commit checks passed 2056 Bun tests, with zero lint warnings and successful typecheck. The compiled-binary smoke also passed with clean shutdown (`compiled-smoke.txt`). The initial full run had failures: the digit fixture indexed an exiting DOM row, and a later added paste assertion incorrectly expected a raw-mode REPL to echo buffered input. Tests now use owned/live targets and actual readiness. An earlier intermittent unavailable attachment was not reproduced in 35 focused repetitions; no backend fix is claimed for it.

Physical iPhone memory eviction, cellular/Wi-Fi transitions, and the user's actual Tailscale HTTP path remain unverified by this simulator work. The native follow-up used Safari, including actual reload and backend restart with durable drafts; prior Home Screen lifecycle evidence remains in [the earlier investigation](../ios-resume-simulator/README.md).

## Reproduction artifacts

The `sizing` and `output` directories preserve original scratch probe sources and JSON results. To rerun their relative imports, copy each directory back under repository-root `.poc-stress-test/` and rename `.ts.txt` sources to `.ts`. Never run probes against the live tmux socket. Native XCTest source and screenshots are under `ios`; memory/runtime controls are under `memory`. Tracked text logs have trailing whitespace and trailing empty terminal rows removed; the external raw archives retain original captures. Production regressions live in the normal test suites and the compiled relay smoke script.

## Visual evidence

The final draft UI is shown in [desktop](persistent-draft-desktop.png) and [phone-sized browser](persistent-draft-mobile.png) captures. The [native Safari report](ios/README.md) includes the actual iPhone Simulator keyboard, backend restart, page reload, and discard checks. Earlier screenshots remain as evidence of the intermediate in-memory implementation.

## Cleanup and delivery

The dedicated remote simulators, SSH forwards, manual browser pages, private tmux fixtures, and compiled smoke executable were removed or stopped after validation. Raw native bundles remain outside the worktree under `/tmp` for debugging. The changes are local commits on `fix/terminal-background-pressure`, stacked on the earlier resume/relay work. Nothing was pushed or deployed. The unmerged worktrees remain available for review.
