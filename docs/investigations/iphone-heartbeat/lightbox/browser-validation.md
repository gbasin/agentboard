# Browser validation

Date: 2026-10-25. Synthetic fixtures only. Production port 4040 was not touched.

## Automated coverage

The first integrated run passed all 24 cases across Chromium and WebKit:

```sh
E2E_PORT=4195 bunx playwright test --config=playwright.media.config.ts \
  media-thumbnail.spec.ts media-lightbox.spec.ts media-rail.spec.ts
```

The gallery fixture contains 126 catalog entries, with images at positions 0, 122,
124, and 125. Navigation crosses the long document/link gap in both directions
without loading intervening rail pages. Assertions cover native Enter, arrow
navigation, terminal-input isolation, pending-navigation cancellation, no replay
on foreground, and no neighbor requests after closing. Thumbnail coverage checks
that large originals require a click and consent resets on each image selection.

The final focused run adds control bounds at 844×320, opener focus restoration,
and application-shortcut isolation while navigation is pending. Its result is
recorded in `e2e-results.txt`. It passed 11 of 12 cases and exposed the Safari
opener-focus defect described below. After that fix, all four lightbox cases
passed on the rebuilt frontend (Chromium and WebKit).

## Manual checks with dev-browser

The private fixture server used port 4196 and a dedicated tmux socket/data root.
The final frontend was rebuilt before opening a fresh browser context.

At 390×844, the viewer showed a preview and the explicit Load full image button.
Loading the full image worked. Next selected the second image. Previous returned
to the first image with full-image consent reset.

At 844×320, measured vertical bounds were:

| Element | Top | Bottom |
| --- | ---: | ---: |
| Dialog | 25.125 | 294.875 |
| Close | 26.125 | 70.125 |
| Load full image | 182.125 | 226.125 |
| Previous / Next | 243.375 | 287.375 |

All controls fit inside both the dialog and viewport. Tab from Next wrapped to
Close. Shift+Tab returned to Next. Enter activated Next. Escape restored focus to
the opening media tile after 400 ms; the terminal textarea was enabled but did
not receive focus.

This validation caught defects before completion: the original minimum image
height placed navigation below the short viewport, and initial loading focus
could prevent restoration to the opening tile. Both were fixed and rechecked. The final WebKit run also caught Safari restoring
focus to the scroll region because clicking a button does not focus it there.
The image tile now explicitly takes focus before opening the viewer; the final
focused matrix checks restoration in both engines.

Screenshots: `preview-390x844.png`, `full-image-390x844.png`, and
`landscape-844x320.png`.

## Limits

WebKit and mobile viewport tests do not reproduce physical iPhone process
suspension, cellular changes, or Home Screen application lifecycle. Lifecycle
regressions use explicit visibility/page events and delayed network responses.
