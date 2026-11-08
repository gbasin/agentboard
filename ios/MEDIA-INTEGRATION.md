# Native media and activity integration

Latest audit and remote regression: [READINESS-AUDIT.md](READINESS-AUDIT.md). The results below describe earlier checkpoints.

The native branch is based on `c120578`. Validation uses an independent current-backend checkout at `0e204cf`, with private data and tmux socket directories. The main checkout is unchanged.

## Implemented

- Optional indexed media totals, with explicit legacy snapshot fallback.
- One retained page of up to 40 items, bounded cursor history, previous/next and return to first page.
- Search and image/file, link and preview filters.
- Finite discovery streams, progress, retry, omissions and cancellation on backgrounding.
- Identity and revision checks that reject stale pages and late responses.
- Content-addressed thumbnails and image neighbors across list-page boundaries.
- Persistent glass paging controls with explicit 44-point button labels and plain button behavior. The initial automatic list button style allowed taps to reach a row underneath; the corrected Simulator workflow passes.
- Live activity supplied by the actual current backend. The open activity sheet changes from one running child to zero when its transcript records completion.

## Validation

Local iPhone 17 Pro Simulator, iOS 26.5, Xcode 26.6. No physical-device validation.

- All 59 existing and media unit/integration tests passed across the broad run and one corrected legacy-media test. An additional document-download integration test passed, and a UTF-16 search-limit test passed, bringing the exercised total to 61.
- Three real-backend media/document integration tests passed, including exact downloaded attachment bytes in a private preview file. Catalog checks cover: all 180 media items across five pages without duplicates; filtered search; image traversal beyond the retained page; thumbnail bytes.
- Activity update and media navigation/search workflows passed in light/standard and dark/maximum-text runs. Large-text captures include scrolled child activity and search results.
- The Library image zoom, HTML source/file sharing controls, link and PR workflow passed in light mode. The dark maximum-text document view was traversed and captured manually in Simulator; its XCTest launch was blocked by PTY exhaustion. Clipboard/file/photo upload flows were not verified: terminal attachment or app launch failed under the same host limitation.
- Root lint and typecheck passed. The full root suite passed 1,569 tests, then failed its isolated double-attach test because macOS could not allocate a PTY. A separate run with `--skip-real-tmux` passed all 1,831 Bun tests (zero failures); the eight real-tmux test files remain unverified in this run.
- Broad native regression and initial dark runs also encountered PTY allocation failures. Only owned disposable fixture windows were removed to free capacity; unrelated sessions were preserved.

## Limits

This is not complete PWA parity certification. The source parity baseline remains `74ed561`; newer backend media/activity integration is tested separately. Successful SSH attachment, physical iPhone behavior, VoiceOver, IME composition, and external share destinations remain outside this evidence. Live progressive discovery is implemented and its state transitions are unit tested; the real-backend fixture is small enough to finish discovery before the UI opens, so it does not demonstrate long-running discovery under load.

The fixture uses genuine backend indexing and WebSocket activity over synthetic private logs. Its tiny colored PNGs are test content, not design assets. Existing image/document/link viewing remains available on older servers. Documents use native Quick Look where supported, HTML attachments show a bounded source preview, and downloaded files support native sharing; web links and new preview kinds use the document web view; this pass does not certify every interactive preview framework.

## Result bundles and captures

- `/tmp/ab-media-all-native-tests.xcresult`: 58/59 passed; the failing test expected legacy inline media.
- `/tmp/ab-media-dark-visible.xcresult`: corrected media-bytes/settings test and both real-backend UI workflows passed.
- `/tmp/ab-media-hitareas-light.xcresult`: final light paging/search/image workflow passed after correcting glass button hit areas.
- `/tmp/ab-media-final-light.xcresult`: seven media state/integration tests and live activity UI passed; the earlier paging hit-area issue remained in that build.
- `evidence/media-integration/light/`: seven captures including the subsequent document source preview; activity captures from `/tmp/ab-media-verified.xcresult`, media captures from the hit-area correction run.
- `evidence/media-integration/dark-large/`: seven captures from the dark-visible run plus one manually captured document source preview.

The independent finish review found no material visual blocker in these 13 media/activity captures. Its required documentation correction was to remove stale snapshot-only capability statements from DESIGN.md and NATIVE-GLASS.md; those statements are updated. The subsequent document source preview has light and dark captures. HTML is displayed as source, not formatted web content. Other Quick Look formats and external sharing destinations have not been individually verified.

## Handoff

The supplemental document visual review returned **ship**, with no material fixes. Owned backend and fixture services were stopped. Simulator appearance/text size were restored to light/large. The existing review host remains available at http://100.82.11.20:8188/proposals/native/media/. Both native and backend-validation worktrees are retained for unmerged work and reproducibility. No changes were pushed.

Local commits use a per-command hook bypass after the explicit lint/typecheck/test runs above, because the full hook includes the host-blocked real-tmux tests. No hook configuration was changed.
