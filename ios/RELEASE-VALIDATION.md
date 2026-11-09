# Integration validation — 2026-11-09

The candidate includes PRs #550, #552, #554, #555 and #556, and master through
`d168f50`. App code was tested at `1f40b1d`. PR #557 corrects test selectors;
the subsequent release metadata declares the same system-only encryption answer
used for TestFlight build 2. No picker or attachment implementation changed from
build 2 (`f9d66b8`).

## Simulator evidence

Host: m5p-2. Xcode 27.2, iPhone 17, iOS 27.2. Fixtures use a private tmux
socket, data directory and disposable shells. Results remain under
`/Users/gary/Code/agentboard-ios-release-integration/ios/evidence/` on that host.

| Result bundle | Result |
|---|---|
| `e2e-20261109-111437-light-all.xcresult` | 78/78 native tests; 36/39 UI workflows |
| `final-selector-recheck-light.xcresult` | PR link and keyboard/rotation passed; Files failed |
| `e2e-20261109-114420-dark-all.xcresult` | 28/31 UI workflows at maximum accessibility text |
| `e2e-20261109-120253-dark-lifecycle.xcresult` | 3/3 lifecycle workflows after edit-menu selector correction |

The original failed bundles remain failures. Targeted corrections establish
38/39 unique light workflows and 30/31 unique dark workflows; they are not a
clean full-suite rerun. The corrections query SwiftUI links as links, scroll
quick keys into view, and recognize both “Forward” and “Next Page” in native
edit menus. Assertions for insertion, lifecycle behavior and text replacement
remain intact.

## Files picker investigation

The file fixture exists in Documents and the system picker reports one item,
but tapping the app's folder does not enter it. It reproduces on a fresh iOS
27.2 Simulator and in a standalone SwiftUI app with only `.fileImporter`.
Changing the folder activation did not fix it; no speculative product fix or
retry was retained. The isolated probe is at `/tmp/ab-picker-probe` on m5p-2;
`/tmp/ab-picker-probe-result2.xcresult` records the minimal reproduction.
The iOS 26 comparison stopped earlier at location navigation and is inconclusive.

The user confirmed use of the native picker on the installed phone build.
That does not certify upload and terminal insertion on build 4. Photos and
mixed clipboard upload/review/insertion passed both appearances. Keep Files
selection through insertion as an explicit phone acceptance check.

## Repository and hosted checks

Lint and typecheck pass. The earlier required local repository test command
failed at the previously reproduced `pipePaneRelay.integration.test.ts` burst
timeout. Logs: `/tmp/ab-final-menu-checks.log` on the local development machine.
Standard hosted CI passed in run `42676848699` at `8f21619`.

GitHub's Actions/Checks incident prevented the earlier candidate runs from
starting. After recovery, native run `42676848768` built successfully but its
light-terminal fixture failed before UI tests: load1 reached 597 on a three-CPU
runner, followed by tmux timeouts and a failed warm-up. The run was cancelled;
no native hosted pass is claimed. Downloaded phase/backend evidence is under
`/tmp/ab-hosted-final-terminal` on the local development machine.

## Release boundary

Build 4 (`0.1.0`) was archived and strictly signature-verified on m5p-2. It
includes `ITSAppUsesNonExemptEncryption=false`, matching the existing system-only
networking declaration. Build 3 was archived but not uploaded; build 4 supersedes
it. Distribution status belongs in [TESTFLIGHT.md](TESTFLIGHT.md).

The app stack is being consolidated for landing through #548 at the user's request. Files phone acceptance and a clean hosted native run remain open follow-ups; landing source does not certify those checks or publish a public App Store release. Physical VoiceOver, IME, real-agent image acceptance and the other external-service limits in [PARITY.md](PARITY.md) remain open.

## Harness-logo follow-up and landing

PR #558 adds the web app's harness marks to native session lists. At `35fafbe`, lint, typecheck and the full repository test command passed (`/tmp/ab-harness-tests.log`), including the previously failing relay integration test. This newer pass supersedes the local test blocker above without changing the historical failed runs. Standard hosted checks also passed on the pre-logo integration revision (`42681916396`, systemd `42681916319`). The full standard CI run for the logo revision (`42706433844`) subsequently passed. The landing documentation check also passed lint, typecheck and the full repository test command (`/tmp/ab-ios-landing-tests.log`).

The logo build succeeded on m5p-2. Both NativeGlassUITests workflows passed in light/large and dark/accessibility-XXXL (four executions). All six marks and the terminal fallback were visually inspected in both appearances. See `evidence/harness-logos/README.md` for captures and result bundles. These focused passes do not replace full-suite native acceptance.

#548 contains the final app, flow, single-row controls, TestFlight and CI changes from #530, #539, #540, #541, #543, #545 and #547. The one TestFlight documentation commit not present by ancestry is already reflected in TESTFLIGHT.md. Close the earlier PRs as superseded only after #548 lands.

The Simulator was restored to light/large and shut down. Fixture cleanup ran.
The three disposable diagnostic Simulators were deleted. Diagnostic sources,
result bundles and archives remain for reproduction. Clean merged worktrees
with active shell working directories remain in place; unmerged worktrees are
preserved.
