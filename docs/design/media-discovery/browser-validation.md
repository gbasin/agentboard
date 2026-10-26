# Browser validation

Date: 2026-10-26. All fixtures contain synthetic images and example.com links.
Production port 4040 was not used.

## Results

The final frozen-source matrix passed **66 of 66 cases** across Chromium and
WebKit in 10.5 minutes:

```sh
bun run build
E2E_PORT=4195 bunx playwright test --config=playwright.media.config.ts
```

Coverage includes progressive rendering, a generated 33 MiB transcript,
terminal use after discovery, newest-first image navigation, background
cancellation, bounded page/catalog payloads, thumbnail fitting and failures,
Links search/pagination, and copying full destinations.

The first matrix passed 58 cases and failed six obsolete assertions, three per
engine. They expected no entrypoint for empty sessions, cold JSON page reads to
initiate scans, and JSON reads to refresh rewritten transcripts. Tests now assert
an accessible entrypoint and explicitly request discovery before freshness
checks. The final run had no failures or retries.

The focused hook suite passed 27 cases; the bounded frame reader passed six.
These include synthetic pending-zero counts, unknown-to-known hydration without
closing the panel or image, malformed/oversized frames, split UTF-8, retained
rows after errors, and automatic continuation capped at four requests per
open/query. Continuations preserve visible rows and use short backoff; exhaustion
leaves an explicit Retry action.

## Progressive rendering proof

The browser regression uses a real tmux session and real image payloads, with a
controlled fetch ReadableStream for deterministic frame delivery. It proves the
first row appears before done, later results cannot prepend or replace visible
rows, and hide/return resumes without replaying navigation. Closed views make no
new requests. This test proves the browser transport/state contract, not writer
scheduling. Backend worker tests separately cover committed publication and
independent reads.

The 33 MiB smoke generates its transcript at runtime and waits only for session
association before opening Media. It exercises the real worker/HTTP/UI path and
checks terminal input afterward. It does not assert a wall-clock scan duration.
No private transcript contents are committed.

Manual dev-browser screenshots show a usable thumbnail while a controlled
stream remains open at 45%, with explicit partial-result text. The image opens
fullscreen before discovery completes:

- `browser-partial-mobile.png`
- `browser-partial-viewer.png`

The first manual frame-delivery attempt ran before terminal readiness allowed
fetch. Waiting for the pending request before delivery resolved this harness
sequencing error.

## Clipboard and mobile layout

Both engines verify a destination longer than 3,200 characters. The deterministic
HTTP fallback test captures the selected textarea value and selection range,
checks the read-only flag, confirmed-success icon and reset, failure feedback,
button focus, and absence of external navigation or terminal input. The fallback
success/failure result is instrumented; it does not claim an operating-system
clipboard write. Evidence: `browser-copy-chromium.png` and
`browser-copy-webkit.png`.

Chromium also exercises native clipboard readback. A separate manual pass used
real execCommand with browser clipboard permissions: all 3,243 characters,
including the final fragment, copied successfully. Meta+V into a separate
textarea pasted all 3,243 characters with exact equality. No clipboard stub was
used in that manual pass.

Root independently checked the real backend: Links had equal scroll/client
widths of 372 pixels at a 390-pixel viewport; the viewer filled 390×844; Next then
Previous returned to the same image URL. Evidence: `browser-root-links.png` and
`browser-root-viewer.png`.

Close-button focus was checked after the restoration frame: after 400 ms, focus
was on the opening media-thumb button, not the terminal textarea. The existing
Chromium/WebKit gallery tests also check Escape focus restoration after 350 ms.

## Cleanup and limits

Ports 4195 and 4196 used private tmux sockets, data directories and transcripts.
The manual fixture was retained briefly for root's independent pass, then its
server and private resources were stopped and removed.

Desktop WebKit and viewport/lifecycle simulations do not reproduce a physical
iPhone's process suspension, cellular conditions, notch, or Home Screen app
lifecycle. Native Chromium copy/paste does not establish physical iOS clipboard
behavior. The previously observed intermittent terminal-attach failure did not
recur in the final matrix; this does not establish its underlying cause is fixed.
