# Native readiness audit — November 8, 2026

## Parity completion follow-up

The integration now includes current PWA baseline `35483b5`. The four feature gaps in the historical audit below have implementations: frozen native text selection with shared copy normalization, configurable terminal autocorrect, attachment preview/removal, and an optional cross-session status overview. Their implementation commits are `2500993` and `dafe721`, with follow-up verification fixes on the same branch.

Current verification on m5p:

- Root lint, typecheck and all 2,581 Bun tests passed, including the pre-commit runs. No hook bypass was used for these follow-up commits.
- All 71 native unit/integration tests passed against the isolated current backend. They cover attachment review and cancellation, preserving a pending review during frozen selection, input replacement, and snapshot request fencing.
- Five new/updated UI workflows passed in light and dark/maximum Dynamic Type: frozen selection/refresh/copy/return to input, session-overview switching, clipboard preview/removal/insertion, photo review/upload, and file review/upload.
- Device preference toggles persisted after reopening Settings in light and dark/maximum text. Frozen selection now has captures with active native selection handles in both modes.
- Visual review found and corrected maximum-text attachment action wrapping, filename truncation, duplicate review controls, and snapshot initial scroll positioning. A passing UI test alone did not expose these issues.
- A fresh independent finish review returned **ship** for the new selection, attachment review, overview and settings surfaces in light and dark/maximum text. This is a scoped visual verdict, not full-app certification.
- A native macOS/Xcode CI workflow now runs the fixture-backed matrix and uploads result bundles. Hosted execution is pending; adding the workflow is not evidence that CI has passed.

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

Current follow-up captures: `evidence/ci-finish/`. The suite now contains 72 native tests; the 72-test set has not yet run as one bundle. Existing hosted evidence is 71/71 plus the four passing media integration tests after adding PDF coverage.

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
