# Native precision checkpoint

The user selected Native precision with glass throughout the native interface. This checkpoint implements the first three core surfaces: Sessions, Terminal and Library. It does not certify full PWA parity or approve a broader styling rollout.

## Implemented surfaces

| Surface | Change | Preserved behavior |
| --- | --- | --- |
| Sessions | Glass rows; provider/project metadata; optional short ID; latest message; minute-updated recency; PR states and overflow; optional agent activity | Search, filters, sorting, native reorder, capability gating and management context menus |
| Terminal | Glass quick-key row, reconnect notice and available-media button; title opens the session switcher; one-shot Shift in the arrows popover | Xterm rendering, native input, tap-to-keyboard, focused-only dismissal, existing session actions |
| Library | Glass saved-session rows with state, provider, project and error context | State and pinned filters, search, pagination, conversation destinations, saved detail and recovery scope |

`NativeGlass.swift` uses real SwiftUI glass on iOS 26 or later. Earlier supported systems use regular material. Reduce Transparency replaces these custom materials with an opaque semantic surface. System navigation, menus and sheets retain platform presentation. The terminal remains solid for legibility.

Shift+Tab sends `ESC [ Z`. Shift+Enter sends LF instead of CR. Shift resets after the next input, keyboard dismissal or leaving the active scene. This is a one-shot interaction, not the PWA’s held touch modifier. Hardware Shift+Return also inserts LF.

## Contract boundaries

Agent activity is optional. The native decoder follows the newer backend’s `session.activity` schema, including running, blocked, unknown and truncated observations. Older servers show no invented subagent count. The subsequent local integration validates live running-to-completed updates against actual backend `0e204cf`, including updates while the activity sheet stays open, in light and dark/maximum-text Simulator runs.

The original glass checkpoint counted only the supplied session snapshot. The subsequent media integration implements the newer `mediaSummary` contract: indexed totals, bounded cursor pages, search/filtering, discovery progress and image neighbors across pages. A persistent glass bar keeps paging reachable. Older servers retain the explicitly labeled “Available” snapshot fallback. See [MEDIA-INTEGRATION.md](MEDIA-INTEGRATION.md) for current evidence and limits.

PR chips use the existing batched `/api/pr-info` endpoint. Missing or failed state lookup stays unknown. Catalog PR navigation opens a PR-only list and does not assert that omitted media is absent.

## Validation boundary

Scoped validation is complete as recorded below. Full backend and physical-device validation remain outstanding. Historical evidence in `PARITY.md` and `DESIGN.md` predates this treatment and cannot certify it. No physical-device, VoiceOver, IME or full-parity approval is claimed by this document.

### Local validation, 2026-11-07

Host: local M1 Mac, Xcode 26.6, iPhone 17 Pro Simulator running iOS 26.5 (`5ED12E2A-C2A9-4246-8C91-C9692E2E8EBB`). The user deferred both remote Macs and physical-device testing for this run.

- Build passed. The checkpoint bundle `native-glass-local-checkpoint.xcresult` passed 46 native tests after explicitly excluding six tests requiring the isolated real backend. The first broad attempt failed those six because their backend was absent; it is not a full-suite pass.
- The original protocol UI run passed hidden approvals, reordering, recovery and remote capability gating. The filter workflow passed on rerun. Its harness now ensures toggles are fully above the native search overlay before tapping.
- `native-glass-ready-light.xcresult` passed the new activity → PR → terminal → keyboard/Shift → Library flow. It verifies the received `ESC[Z` and LF inputs through the loopback fixture. The first run found and fixed a real empty-area touch target in the activity button. Another attempt tapped before terminal readiness; the harness now waits for enabled input and rendered terminal output.
- Repository lint and typecheck passed. The first repository test attempt hit a timing-sensitive spawn assertion; that file passed separately. The second attempt passed the 1,505-test main batch plus 64 tests across subsequent groups, then failed the real tmux double-attach integration because its private server could not create a window. A separate native backend seed also reported `fork failed: Device not configured`. No full repository-suite pass is claimed.

All protocol UI fixtures are synthetic and loopback-only. They do not prove live SSH, real GitHub, physical keyboard/IME, or complete backend parity. Later compact-layout light/dark results and visual review follow below.

### Compact-layout regression results

`native-glass-verified-light.xcresult` and `native-glass-verified-dark.xcresult` each passed all six selected UI workflows: the new catalog/activity/PR/media/keyboard/Shift/Library flow, hidden approvals, persisted reorder, shared filters/history, recovery notice behavior and remote capability gating. Dark mode used maximum accessibility text size. Moving connection state into the toolbar required tests to observe its accessibility value rather than the removed banner's text.

The visual review then found compressed numeric metadata despite passing interactions. PR labels now use intrinsic width with a compact count fallback; the activity count uses explicit image/text content. Subsequent final-theme runs and session recaptures are the current visual evidence, not the earlier compressed-label images.

The work is retained in the unmerged `feat/ios-native-precision-glass` worktree. No push or PR publication occurred. The isolated real-backend process and its private `ab-ios-parity` tmux session were stopped. The protocol fixture is stopped after capture. The Simulator returns to light appearance and standard text size. The user's proposal host remains running.

### Final capture pass

The full new flow passed again in `native-glass-final-light.xcresult`, `native-glass-final-dark.xcresult` and `native-glass-final-accessibility.xcresult`. The last image/text correction to the subagent count then built successfully. Only the three Sessions screenshots were refreshed with `simctl` after installing that build, resetting the same fixture, and relaunching the app in each appearance. Other screenshots come from the passing final-theme XCTest attachments.

Evidence: `evidence/native-glass/` contains six views in each of three appearances. Standard light/dark are the design comparison; maximum-text dark captures demonstrate adaptive behavior. Library's pinned section header at maximum text remains a visual-polish followup. This checkpoint does not replace the broader full-parity checklist.

The final independent reviewer inspected all 19 captures and returned **ship this scoped native checkpoint**, with no remaining scoped blocker. `native-glass-ax-metadata.xcresult` separately passed a maximum-text check that both activity and PR controls remain hittable; its scrolled capture verifies readable counts. Hosted review: http://100.82.11.20:8188/proposals/native/.
