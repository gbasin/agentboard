# Thumbnail browser validation

Validation used the isolated thumbnail worktree and private tmux, database, and
transcript directories. The live 4040 server was not changed.

## Manual browser observations

The dev-browser CLI opened an isolated server on 4194 in headless Chromium at
390×844. The fixture contained 17 distinct media items, including one invalid PNG.
The initial strip displayed a decoded image and a `No preview` fallback without
horizontal page overflow.

- Opening the strip requested 7 near-viewport thumbnails: 6 decoded successfully,
  1 displayed the failure fallback, and 10 offscreen items stayed idle.
- Jumping to the end requested 7 more thumbnails. Items skipped in the middle
  remained idle.
- No original image was requested during either step.
- Tapping a ready thumbnail opened the lightbox and requested exactly 1 original.

The observations are retained in `browser-observation.json`. Screenshots are
`mobile.png`, `mobile-scrolled.png`, and `lightbox.png`. The isolated server,
fixture, private tmux server, and browser page were cleaned up afterward.

This is a Chromium mobile-viewport check, not a physical iPhone or native Safari
suspension test. The automated WebKit suite covers the same browser workflows,
with visibility/pagehide simulation explicitly separated from OS suspension.

## Automated coverage

The final thumbnail-specific matrix passed 6/6 in Chromium and WebKit after preserving
the original-open budget and completing the cooperative worker-shutdown fix. It exercises a 512×256 image larger than 64KiB, 128px
thumbnail output, viewport-only requests, no automatic original downloads,
large-original opening in a separate tab, small-original lightbox opening,
corrupt-image fallback without retry loops, and pending-request cancellation
across simulated background/foreground events. See `thumbnail-e2e.txt`.

The initial broad run passed all 20 existing Chromium media tests. Its first
new thumbnail test used a stale fixture version with repeated image content,
which the index correctly deduplicated into 2 items instead of 40. The next test
also retained the old fixture-selection flow, which tried to click the desktop
sidebar after switching to a mobile viewport. That run was interrupted; both
fixture issues were corrected and the fresh 6-case run passed. This is retained
in `initial-e2e.txt` rather than counted as a passing full run.

One attempt to start two separate E2E runs simultaneously failed before any
WebKit tests, reporting only a webServer process exit 1. The private startup log
was removed by teardown, so the cause is unconfirmed. The WebKit regression run
was then started sequentially and passed all 20 existing media cases in 2.9 minutes; see `webkit-e2e.txt`.

Across the completed runs, all 46 unique media cases passed: 20 existing Chromium
cases, 20 existing WebKit cases, and 6 final thumbnail cases. The existing Chromium
run preceded the large-original popup adjustment; the final 6 cases exercise that
adjustment in both engines. No full-matrix pass is inferred from the interrupted
initial run. All isolated validation servers and private tmux fixtures were cleaned
up; ports 4193, 4194, and 4195 had no listeners afterward.
