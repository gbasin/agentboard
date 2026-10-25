# Mobile lightbox and Links validation

Date: 2026-10-25. All fixtures contain synthetic images and example.com links.
Tests use private tmux sockets, transcripts, and databases on ports 4195/4196.
The validation does not use the production server on port 4040.

## Coverage

The combined Chromium/WebKit media matrix includes 60 cases. It covers image
navigation, Links search and pagination, stale responses, background cancellation,
media payload integrity, lazy thumbnails, and small reconnect payloads.

The updated tall-image regression uses a 256×512 original. It checks fullscreen
390×844 bounds, contain fitting, a painted image larger than 300×600, and close
and navigation controls inside portrait and 844×320 landscape viewports. Only
selected originals load; opening the rail alone loads no originals. Next loads
one new original. Previous may use the browser cache.

Combined Links tests open and close the viewer, switch to Links, search, return
to Media, reopen the viewer, and close the rail. Both desktop and mobile preserve
focus and keep text input out of the terminal.

## Investigation notes

The first tall-image assertion retained the landscape fixture's 128px thumbnail
width. A portrait thumbnail is 64×128, so the assertion was corrected to 64px.

The full run also encountered a terminal attach failure in the delayed-page
session-switch case. The first snapshot showed the correct Links tab with
"Waiting for terminal recovery" and "ERR_TMUX_ATTACH_FAILED: tmux client exited".
Follow-up results are recorded in e2e-results.txt. Read-only backend review
confirmed this happened before media requests: the tmux attach process exited.
The cause is unknown, and current logs omit its exit code. A retryable terminal
error on an open WebSocket does not automatically reattach; optional media can
remain paused until session reselection or reconnect. This existing limitation
was not changed in the lightbox work.

Bun prints a stack containing node:assert when both NO_COLOR and FORCE_COLOR are
set. This is a color warning, not an assertion failure. The identical stack was
reproduced by importing node:assert in a standalone Bun process, which exited 0.

## Limits

Desktop WebKit with mobile dimensions and synthetic visibility events does not
reproduce a physical iPhone's process suspension, notch, cellular transport, or
Home Screen lifecycle. Those require device testing.

The repeated session-switch run exposed a test teardown race: the interception
flag was set before route.fetch completed, so the context could close while its
handler was still fetching. The test now waits for the backend response before
announcing the delayed delivery and drains routes before destroying fixtures.
No production behavior was changed for this test correction.

## Manual browser measurements

The final rebuilt frontend was opened in a fresh dev-browser context on 4196.
At 390×844 the panel filled the viewport. The stage measured 390×697; the tall
image painted 346.5×693 with its aspect ratio preserved. Close occupied y0–44,
and Previous/Next occupied y793.5–837.5. At 844×320 the panel again filled the
viewport; Close occupied y0–44 and navigation y269.5–313.5. All controls remained
inside the viewport. Next/Previous and Escape worked. Screenshots were inspected
and retained as portrait-390x844.png and landscape-844x320.png.

The manual fixture server and its private tmux/data root were stopped and removed.
