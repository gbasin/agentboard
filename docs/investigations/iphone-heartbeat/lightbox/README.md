# Navigable image lightbox

Every image tile opens the same viewer. Documents and links keep their existing open behavior. The viewer provides Previous/Next buttons, Left/Right arrows, Escape, a close button, focus trapping, and terminal input suspension.

Opening or navigating to an image loads that selected original automatically, including large, unknown-size, and external images. A cached thumbnail remains visible while it loads. The rail still fetches thumbnails only, and adjacent originals are never prefetched. The viewer also offers **Open original** in another tab. One original is mounted at a time; it unmounts during background/recovery and reloads the current selection on return. Removing an image element is not a guarantee that every browser immediately cancels its network request or frees decoded pixels.

## Navigation without page retention

The rail retains three pages and a bounded cursor trail. Those caches cannot be the gallery's authoritative history: long sessions would lose backward navigation, and sparse image collections would require reading many link-only pages.

`GET /api/session-media/:id/neighbors?anchor=<descriptor-url>` returns the current image and its immediate previous/next images. The metadata worker performs two indexed tuple seeks using `(identity, kind, time, path, offset, item)`. A separate anchor index resolves the current descriptor. Non-image items are skipped without walking their pages. Responses contain at most three descriptors and stay within the existing 64 KiB detail budget. Catalog/WebSocket payloads remain unchanged.

The anchor must be a canonical content-addressed local descriptor for that session and match the current indexed row. Reassociation and rewritten/deleted anchors fail closed. The lookup uses the current index, so an explicit navigation action can see newly appended images; it never automatically moves the selected image. Page and neighbor RPCs share the existing 32-request admission bound and stale-response fencing.

The client holds one selection and one neighbor response. Requests occur when opening/selecting an image, explicitly retrying, or restoring the still-open viewer after recovery. Hidden/recovering views abort pending lookups and thumbnails. Late responses cannot overwrite a different selection. Resume can refresh the current selection's controls but never repeats a previous navigation action. Failures remain visible with a manual retry.

## Validation

Backend coverage includes a 6,000-link gap, global subagent ordering, first/last boundaries, canonical anchor validation, append/delete/rewrite cases, identity changes, shared admission, and a real metadata worker. Client coverage checks source changes, rapid/cancelled selection, selected-original loading, keyboard boundaries, late responses, and recovery.

The browser regression uses 126 mixed media items with four widely separated images. It verifies forward and backward gallery navigation with only one rail-page request, no terminal input leakage, selected-only full-size loading, and background recovery. Chromium/WebKit and manual visual evidence are retained beside this report after validation. Browser lifecycle simulations do not establish native iOS suspension behavior.

Schema changes add indexes only and remain compatible with the previous server for rollback. Large-original extraction still uses the existing payload route; this change does not move explicit original decoding or serving into the thumbnail worker.

## Review and short-screen corrections

Claude's read-only review (`20261025-153535-claude-65a4dd34`) found no blocking backend or navigation-race issue. It identified focus loss when a navigation button becomes disabled and an impossible neighbor request for unindexed external URLs. Navigation now moves focus into the panel before disabling controls and fences stray keyboard events; external image URLs do not request local neighbors. Closing the viewer restores the opener rather than focusing the terminal textarea, preserving the existing default for other dialogs.

Manual testing at 844×320 found the original fixed minimum image height pushed Previous/Next below the viewport. The image area now shrinks and scrolls while keeping controls visible. Short-screen bounds and focus isolation are covered by follow-up browser regressions. These fixes preserve 44 px touch targets.

## Mobile readability follow-up

The viewport-sized layout replaces the content-sized dialog. Phones, including short landscape viewports, use the available browser viewport with safe-area padding. Desktop uses an inset viewport-sized panel. The image stage has a definite size and uses `object-fit: contain`, so both previews and originals fill the available area without cropping or distortion. This follow-up also integrates the Links view from PR #441; gallery neighbor queries remain independent of filtered Media/Links pages. The previous browser report records the original implementation; current validation lives in the mobile-lightbox report.
