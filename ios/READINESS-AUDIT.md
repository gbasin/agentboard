# Native readiness audit — November 8, 2026

## Parity completion follow-up

The integration now includes current PWA baseline `35483b5`. The four feature gaps in the historical audit below have implementations: frozen native text selection with shared copy normalization, configurable terminal autocorrect, attachment preview/removal, and an optional cross-session status overview. Their implementation commits are `2500993` and `dafe721`, with follow-up verification fixes on the same branch.

Current verification on m5p:

- Root lint, typecheck and all 2,581 Bun tests passed, including the pre-commit runs. No hook bypass was used for these follow-up commits.
- All 76 native unit/integration tests passed against the isolated current backend. They cover attachment review and cancellation, preserving a pending review during frozen selection, input replacement, and snapshot request fencing.
- Five new/updated UI workflows passed in light and dark/maximum Dynamic Type: frozen selection/refresh/copy/return to input, session-overview switching, clipboard preview/removal/insertion, photo review/upload, and file review/upload.
- Device preference toggles persisted after reopening Settings in light and dark/maximum text. Frozen selection now has captures with active native selection handles in both modes.
- Visual review found and corrected maximum-text attachment action wrapping, filename truncation, duplicate review controls, and snapshot initial scroll positioning. A passing UI test alone did not expose these issues.
- A fresh independent finish review returned **ship** for the new selection, attachment review, overview and settings surfaces in light and dark/maximum text. This is a scoped visual verdict, not full-app certification.
- The hosted macOS/Xcode light matrix passed all 76 native tests and all 34 UI workflows. The dark/maximum-text job passed 24/26; its menu-navigation and cascading shell-input failures are being corrected. A fully green hosted matrix is still pending.

The feature gaps below describe the earlier audit, not the current implementation. The physical-device and external-service verification boundaries still apply. Broad light and dark Simulator runs completed; the failures and correction runs are recorded below. This is evidence across runs, not a single green full-matrix bundle. Running observations and possible product changes are recorded in `PARITY-NOTES.md`; those ideas are not approved scope.

## Broad-run corrections

The current baseline is `35483b5`. Commit `32f5561` fixes a native mapping defect found by the broad run: a live session can retain the stored `isHibernating` marker after Wake. The native client now follows live wire status, as the PWA does, while dormant conversations remain in their separate collection. Eight connection tests and both real media/activity UI workflows passed the correction run.

The broad light run then passed all 71 native unit/integration tests and 32 UI workflows. It exposed one landscape regression and skipped the opt-in tailnet smoke test. The new status/media inset left only 8 points of terminal height with the landscape keyboard open. Compact-height navigation now contains those same controls; portrait layout is unchanged. Both the rotation/typing workflow and an added media-rich landscape workflow passed in light and dark/maximum text. Back navigation after dismissing the keyboard also passed. A fresh scoped visual review returned **ship** for this correction.

The optional read-only smoke test was explicitly configured against the private fixture's tailnet address and passed. This validates access using that address on the Simulator host; it is not a physical-device or cross-host network test. The light workflow set is covered across the broad and correction runs, not represented as one clean full bundle. The dark/maximum-text matrix passed 23 of 26 UI tests. Two media tests waited for offscreen lazy rows; one creation test scrolled the underlying list behind a keyboard-covered sheet. Test helpers now search for fixture sessions and scroll within the front form’s visible viewport. Context-menu actions use their own helper. Both media workflows and PR states passed the correction run; creation/duplicate/hibernate, settings/destinations, file upload/insertion and photo upload/insertion then passed together (4/4). No product change was required for these harness corrections. The final light correction run passed all six affected workflows together (the same four plus both media/activity tests). The latest test-only correction is `ee5bf2b`; its full repository pre-commit checks passed. Hosted native CI is still pending.

Live GitHub retrieval remains blocked on m5p: its existing `gh` login token is invalid, and the real backend returns `error: unavailable`. Fixture-backed PR rendering passes. Reauthentication is required before claiming successful live PR/CI retrieval.

## Hosted CI follow-up and PDF validation

Hosted run `42500942851` passed 71 native unit tests and failed two of 34 light UI workflows: creation-menu navigation during attachment startup and a terminal tap before readiness. The tests now wait for enabled terminal input, re-query menu targets and use short directional drags. Both workflows passed together in light; each passed in dark/maximum text after the menu correction. A longer drag attempt failed and was replaced, not counted as passing evidence.

Light and dark now run as separate CI jobs with separate artifacts. Build plus light took approximately 53 minutes on the hosted runner; the previous 60-minute combined job did not leave enough room for the full matrix. Hosted success remains unproven until the new jobs finish.

The failure recording also exposed a portrait count splitting digits. The detailed media summary now measures at its intrinsic width so ViewThatFits chooses the existing compact total when necessary. Light/dark portrait and landscape captures passed scoped independent visual review.

A new real PDF fixture exercises the existing Quick Look path. Four media integration tests passed, including PDF download, preview eligibility and temporary-file cleanup. The complete Library HTML/PDF/link workflow passed in light and dark/maximum text, with visible PDF pages captured. The first attempt used a freshly rewritten fixture before its media index refreshed and failed on stale document entries; after verifying both document URLs returned their current bytes, the rerun passed. This does not establish external share completion, all Quick Look formats, or physical-device acceptance.

Current follow-up captures: `evidence/ci-finish/`. All 72 native unit/integration tests passed together in `/tmp/ab-ci-native-72-final.xcresult`. An earlier run failed only the old three-item fixture count; the assertion now expects four items and explicitly checks PDF presence. Hosted evidence remains the earlier 71/71 until the next CI run.

Read-only native SSH attachment also passed through a separate cross-host backend and actual SSH transport, with remote commands constrained to the private fixture socket. The test confirmed remote session selection, terminal readiness, rendered output and Back navigation. See `evidence/ci-finish/ssh-attach.md`; this closes successful SSH attachment for the tested topology, while remote management and physical-device networking remain outside its scope.

Live GitHub retrieval also passed through this Mac’s existing authenticated backend (`100.82.11.20:4040`). The optional native UI test opened PR #530 directly from the catalog PR control, asserted its real title and check name, and captured the actual statuses. It never opened a terminal or changed settings/credentials. This verifies the complete native catalog → PR → live checks read path; m5p’s invalid gh token remains host-specific. Result: `/tmp/ab-live-github-checks.xcresult`, one passing test in 12 seconds. The capture shows the previous native CI failure accurately, not a green CI claim.

## External acceptance and finite discovery renewal

Commit `fbcdf1c` corrects the next hosted failures: native Clear text replaces a flaky Command-A search sequence, Files navigation respects its remembered directory and cold startup, Photos waits for its first-use notice, and menu taps use a verified visible center. Hosted run `42507761352` passed 72 native tests, 32/34 light UI tests and 24/26 dark UI tests; its failures remain recorded as failures.

The real 500,001-reference transcript exposed an implementation gap: the PWA renews unfinished finite discovery streams automatically up to three times, while native stopped for manual continuation. Commit `6d2e781` adds the same bounded renewals, preserves a nonempty visible page, cancels delayed renewals, and resumes partial discovery on foreground. Stream events decide completion even if catalog broadcasts lag. Four new focused tests passed; the full native unit/integration suite passed 76/76.

The real large-transcript workflow passed in light and dark/maximum text: visible progress, background/foreground recovery, completed discovery, refresh and page-two navigation. The final dark test also asserts the complete 500,001-item count. PDF Save to Files passed both appearances; the saved PDF's SHA-256 and 666-byte length exactly match the source. A real Codex CLI editor accepted the native clipboard image as `[Image #1]`, without submitting a prompt. See `evidence/external-acceptance/README.md` for result bundles, corrections, isolation and limits.

Remaining acceptance boundaries are physical iPhone installation/performance, IME/VoiceOver/hardware keyboards, HEIC photos, model-side image interpretation and other agent editors, other share destinations, other Quick Look formats, and arbitrary SSH configurations/remote management. A successful hosted full native matrix is still required; source and targeted runs are not represented as that result.

## Hosted full-matrix checkpoint

Run `42514977955` at `68ee9db` passed all 76 native tests and all 34 light UI workflows. Dark/maximum text passed 24 of 26 UI workflows. Number keys failed because a context-menu item's accessibility frame extended below the visible popup. The later rotation check inherited the unfinished `NUM_…` shell command; its failure hierarchy shows `NUM_F1F886C8_OK` instead of the expected rotation prefix.

The test correction reads the popup's enclosing accessibility bounds, shares that menu helper between workflow classes, and cancels unfinished input through native Control-C before the rotation test. Earlier hosted run `42513507774` also exposed a midpoint-only reorder drag and a cold Files picker. Reorder now crosses the destination midpoint and holds before release; Files waits for its system navigation bar. Order, backend persistence, relaunch, picker and terminal-output assertions remain in place. These changes affect tests only. The corrected settings/destinations, create/rename/cancel/end, and rotation workflows passed together in dark/maximum text (3/3, `/tmp/ab-menu-shared-dark.xcresult`). Reorder passed light and dark with backend persistence and relaunch checks. Earlier menu attempts using screen fractions and a shorter scroll budget failed and remain diagnostic results. Full hosted verification of the corrected tests is pending.

## Historical audit

Reviewed native head `ef4383d` against the original PWA baseline `74ed561` and current PWA `35483b5`. Current media/activity integration uses backend `0e204cf`. A read-only merge-tree check against current master found no conflicts. The native branch changes only `ios/`; it does not change the production web client or backend.

## Findings

One accessibility-identifier collision was found and corrected: the offline detail row propagated `connection-status` to its Retry button, duplicating the toolbar identifier. The XCTest UI hierarchy confirmed both buttons shared it. The detail row now uses `connection-detail`; the toolbar remains `connection-status`. No visible design or control action changed.

No other blocking source defect was found in the inspected media paging/revision/cancellation paths, bounded document downloads, terminal connection ownership, or upload queue delivery. This is a scoped source review, not proof that every feature works.

The current PWA has additional features absent from the native client:

| Priority | Gap | Source evidence | Next step |
|---|---|---|---|
| High | Frozen Select text view, including adjustable native selection and clickable URLs | PWA `8d5603a` and `0b2304e`; native `TerminalScreen` exposes xterm copy selection but no snapshot request/view | Add an explicit native selection view with snapshot identity and input isolation |
| High | Configurable terminal autocorrect | PWA `ce00fd4`, `6d38500`; native `TerminalInputView` sets `autocorrectionType = .no`, with no settings toggle | Implement and test replacement ranges, composition, paste and shell/TUI input before enabling |
| Medium | Image preview and individual removal before insertion | PWA `f11ce92`; native attachment sheet lists uploaded filenames, and clipboard delivery proceeds without an attachment-preview editor | Add a review surface that preserves ordered delivery and exact uploaded bytes |
| Medium | Optional cross-session status peek while a terminal is open | PWA `fce20b8`; native terminal has current-session status, a session-name switcher, and navigation back to the list, but no persistent cross-session status overview | Design a native equivalent without sacrificing terminal width; implementation requires a design decision |

These are current-PWA parity gaps, not regressions against the original native baseline. Existing native Shift, numpad zero, system paste, media browsing and activity views cover other recent PWA additions. The PWA's desktop side-by-side link preview becomes a detail sheet on iPhone; equivalent content support still needs broader preview-content testing.

## Verification boundary

Physical-device signing/install remains deferred. VoiceOver, IME, real-device performance, successful SSH attachment, live GitHub CI retrieval, share completion in external destinations, non-HTML Quick Look formats, and real-agent image acceptance remain unverified. Long-running progressive media discovery has state tests but no slow real-backend UI fixture.

The remote audit uses the reachable m5p tailnet host (hostname MacBook-M5P-2), Xcode 26.4, and its iOS 26.4 Simulator. All fixtures use private data and a private tmux socket. Existing fixture data was preserved in `/tmp/ab-ios-parity-before-media-audit-20261108` before starting fresh data.

- Build for testing: passed.
- Repository lint, typecheck and full Bun suite: 1,859 passed, zero failures, command exit 0. This resolves the prior local real-tmux test block.
- Native unit/integration suite: 61 passed in one run.
- Terminal typing, single-line/multiline paste, background recovery, session switching, mixed clipboard image/text insertion, file-picker upload, photo-picker upload, Library image/document/link viewing, media paging/search and live activity: passed in the light run. That bundle remains a failed bundle because the old Connection selector failed (8/9 UI workflows passed).
- Connection validation initially failed because its UI test used an obsolete label selector. The test now uses `connection-status`, matching the existing connection test helper. No product behavior changed.

## Targeted UI results

Twelve distinct light workflows passed across the initial and correction runs. Eight dark/maximum-text workflows passed across the broad run and two corrections. This is targeted regression, not a new execution of every historical UI test.

| Remote result bundle | Result |
|---|---|
| `/tmp/ab-native-audit-light.xcresult` | 61/61 unit/integration; 8/9 UI, old Connection selector failed |
| `/tmp/ab-native-audit-connection.xcresult` | 3/4 UI; offline duplicate identifier exposed |
| `/tmp/ab-native-audit-offline.xcresult` | Diagnostic failure confirmed duplicate identifiers in the UI hierarchy |
| `/tmp/ab-native-audit-connection-fixed.xcresult` | 4/4 UI after identifier correction |
| `/tmp/ab-native-audit-dark.xcresult` | 6/8 UI; two tests waited for offscreen lazy rows |
| `/tmp/ab-native-audit-dark-visible.xcresult` | Offline recovery passed; media flow reached image/document/link but then scrolled the wrong way toward the PR row |
| `/tmp/ab-native-audit-dark-media-final.xcresult` | Complete media/document/link/PR flow passed |
| `/tmp/ab-native-audit-light-visible.xcresult` | Final media and offline-recovery test changes passed in light mode, 2/2 |

The lazy-row test corrections scroll before asserting row existence, check the visible reconnecting status instead of an offscreen explanatory section, and scroll back toward the PR section. Content, navigation, image zoom, input and upload assertions remain in place. No product layout was changed to satisfy the tests.

The full root checks passed again after the product identifier correction. Local commits use a per-command hook override because local PTY exhaustion remains; equivalent complete checks ran successfully on m5p. No permanent hook configuration was changed by these commits.

Visual evidence is in `evidence/readiness-audit/`: seven light and six dark captures from passing individual workflows. They show terminal input, clipboard insertion, file/photo uploads, offline recovery, connection editing and the HTML source preview. The upload photo capture is scrolled at maximum text size; the insertion action remains visible. These captures do not prove external share completion or real-agent image acceptance.

## Build automation

The repository workflows do not build or test the Swift client. Existing CI validates the web/backend package, including macOS PTY tests. Add a macOS Xcode build and native test job before treating GitHub CI as evidence for native releases; the current native evidence is from explicit Simulator runs.

## Release decision

Commit and branch push are appropriate. Complete-PWA-parity and production-ready claims are not. Keep the integration in draft review while closing the explicit feature gaps and verification limits. No deployment, merge, signing or installation on a physical device is part of this audit.

## Handoff

Draft PR: https://github.com/gbasin/agentboard/pull/530. No merge or deployment. The main checkout was not edited. Test services were stopped; the existing proposal host remains available. Simulator appearance/text size returned to light/large.

Retained worktrees: local `agentboard-ios-audit` and `agentboard-ios-media-integration` hold the open PR work; local `agentboard-ios-backend-validation` pins its integration backend. Remote `agentboard-ios-media-audit` holds Simulator build/results and `agentboard-ios-media-backend` pins the tested backend. These are retained for the unmerged PR and reproducibility. Earlier worktrees were not removed.
