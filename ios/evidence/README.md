# Simulator evidence

Captured on m5p with Xcode 26.4, iOS 26.4, iPhone 17 Pro simulator (94EEE322-8231-4D09-8904-5DE3EFAE934B). Images are screenshots of the built app, not generated mockups. Session names, summaries, and transcript copy are illustrative samples.

## Parity-gap corrections

This pass corrects clipboard image/file delivery, shared history filters, hidden approval visibility, remote capability gating and proactive recovery. The earlier broad parity claim did not establish these behaviors. See [PARITY.md](../PARITY.md) for the implementation and validation boundaries.

| Evidence | Result |
|---|---|
| `gaps-public-paste-light.xcresult` | 43 unit/integration passes and six of eight UI passes; all five gap workflows and file-picker upload passed |
| `gaps-clipboard-photo-light.xcresult` | Corrected clipboard workflow passed; photo confirmation selector failed |
| `gaps-finish-light.xcresult` | Photo upload, hidden approval and recovery passed, three of three |
| `gaps-dark-max.xcresult` | Initial run exited 65; seven explicit control-location failures retrieved, eighth result unavailable |
| `gaps-dark-max-scroll.xcresult` | Three of eight UI workflows passed: clipboard, file upload and photo upload; five catalog workflows failed on test navigation |
| `gaps-dark-gap-navigation.xcresult` | Four of five passed: hidden approval, manual ordering, recovery and remote capabilities; filter navigation failed |
| `gaps-dark-filter-visible.xcresult` | Filter/history workflow passed, one of one (32.084 seconds) |
| `gaps-dark-recovery-row.xcresult` | Recovery-row capture test passed, one of one (19.992 seconds) |
| Repository checks | Lint/typecheck and all 1,859 Bun tests passed |
| Image bytes | The backend file matched the 319-byte input PNG: SHA-256 `16c379714e8987a93fbbb021d0acdc7df147d77a14ca6878dd962d47c109249f` |

All eight affected workflows passed in light/standard-text and dark/maximum-text appearances across these runs. The table preserves failed tests; it does not claim a clean combined eight-test bundle. Test corrections join wrapped terminal accessibility rows, target the native PhotosUI confirmation, and navigate visible native containers/rows with normal scrolling. No product changes were needed for the dark reruns.

### Local capture provenance

`gaps-light/` contains **18 light/standard-text PNGs**:

| Files | Source and scope |
|---|---|
| `gap-manual-reordered`, `gap-manual-order-restored` | Original public-paste run; native reorder and persistence |
| `gap-selected-filters`, `gap-filtered-history`, `gap-filtered-hibernating` | Original run; shared project/host filtering |
| `gap-hidden-approval`, `gap-approval-restored` | Final three-test light run after `eb071c4`; hidden approval and clearing filters |
| `gap-remote-control-disabled`, `gap-remote-control-enabled`, `gap-remote-unmanaged` | Original run; capability/ownership gating |
| `gap-recovery-notice`, `gap-recovery-library`, `gap-new-interruption` | Final three-test light run after `eb071c4`; recovery and per-interruption dismissal |
| `parity-uploaded-file` | Original run; file-picker upload result |
| `clipboard-final-state`, `clipboard-image-and-text` | Successful corrected clipboard run; mixed text/image insertion |
| `parity-photo-picker`, `parity-uploaded-photo` | Final three-test light run; multi-photo confirmation and upload |

Nine captures remain from the original public-paste run; seven come from `gaps-finish-light.xcresult`, including the refreshed hidden-approval and saved-session metadata contrast after `eb071c4`; two come from the successful clipboard rerun. The refreshed images replace the five affected original captures rather than claiming those old images showed the final contrast.

`gaps-dark/` contains **20 PNGs from passing workflows**: five clipboard/file/photo captures from `gaps-dark-max-scroll.xcresult`, eleven hidden-approval/manual-order/recovery/remote-action captures from `gaps-dark-gap-navigation.xcresult`, and three filter captures from `gaps-dark-filter-visible.xcresult`. The twentieth capture, `gap-recovery-saved-row`, comes from `gaps-dark-recovery-row.xcresult`.

Review of all 18 light captures found no new issues and scored both contrast corrections resolved. The reviewer has no outstanding source blocker. The reviewer inspected all 18 light and 20 dark captures and returned **ship this scoped parity-fix UI**, with no further correction required. Five diagnostic PNGs from the failed initial run remain in `gaps-dark-initial/`: `gap-recovery-notice`, `gap-recovery-library`, `gap-selected-filters`, `gap-hidden-approval` and `gap-remote-control-disabled`. These are not passing validation evidence. Simulator light appearance and `large` text size were independently verified. Owned backend, protocol fixture and keep-awake processes were stopped; the private test tmux session was removed. No test runner or port-4151/4192 listeners remained. Proposal hosts were preserved.

Port 4192 supplies controlled filter, remote-capability and recovery data without contacting SSH or production sessions. Shell insertion and exact image-upload bytes do not prove that a real agent accepts an image attachment. Physical-device, VoiceOver, IME, live SSH/GitHub and actual share destinations remain outside this evidence.

## Native design polish

This pass preserves the Apple-native controls, semantic colors, typography and terminal palette. Persistent primary captions identify populated create/duplicate, Settings and preset fields. Each native TextField keeps its original label; its duplicate visual caption is accessibility-hidden. Catalog rows combine project, agent and remote-host context in one caption and omit the repeated local hostname. Pull-request details omit empty metadata rows.

The `design-light/` and `design-dark/` directories each contain six affected-screen Simulator captures: light at standard text size and dark at maximum accessibility text size. These use the isolated backend and illustrative fixtures; they are not generated mockups or shipping raster assets.

- `parity-catalog.png`: combined session metadata.
- `actions-create.png`: persistent labels in the populated create form.
- `actions-error.png`: retained form context and server-error visibility.
- `parity-settings.png`: labeled populated settings fields.
- `parity-preset-editor.png`: populated preset label and command fields.
- `parity-pull-request.png`: pull-request details without empty metadata.

The product source is commit `9f67ee7`; the subsequent test-only changes add initial-catalog and populated-preset-editor captures.

Validation for this scoped polish:

- `design-light.xcresult`: three light/standard-text UI tests passed with no failures.
- `design-light-captures.xcresult`: all three final light/standard-text UI tests passed, covering catalog/preferences, media/link/pull-request and settings/preset/terminal workflows.
- `design-dark.xcresult`: all four dark/maximum-text UI tests passed with zero failures, covering the same three workflows plus session management (248.994 seconds).
- Root lint and typecheck passed. All 1,859 Bun tests passed with zero failures.

The fresh finish reviewer inspected all 12 captures and returned **ship this scoped polish**, with no blockers or required corrections. Direction fidelity and native platform craft passed. Optional future refinements are examples for empty fields and the existing single-line truncation of long default directories at maximum text size. This verdict does not certify full PWA parity, physical-device, VoiceOver, IME, SSH-host attachment or live GitHub behavior. The earlier parity results below describe their own source and validation scope.

## Native parity extension

The earlier parity extension preserved the existing native visual system. See [DESIGN.md](../DESIGN.md) for component patterns and [PARITY.md](../PARITY.md) for the capability and validation matrix.

- `parity-light/`: 51 light/standard-text captures, including final correction recaptures.
- `parity-dark/`: 36 dark/maximum-accessibility-text captures, including final management and correction recaptures.
- Catalog and terminal evidence includes setup, connection, offline, catalog, portrait/landscape, live shell, keyboard, paste, reconnect and session-switch captures.
- `parity-filters`, `parity-create-presets`, `parity-directories`, `parity-settings`, `parity-settings-search` and `parity-presets` cover native catalog controls and configuration.
- `parity-saved-*`, `parity-resumed-terminal` and `parity-transcript-*` cover saved sessions, lifecycle and conversation reading.
- `parity-media-*` and `parity-pull-request*` cover media viewers, documents, links and check states. The blue image, HTML document and pull-request statuses are synthetic fixtures. They exercise rendering and navigation; they are not production content or evidence of live GitHub checks.
- `parity-attach-file`, `parity-photo-picker`, `parity-uploaded-*` and `parity-number-keys` cover pickers, insertion and supplemental terminal input.

These PNGs are Simulator test evidence, not generated shipping raster assets. No generated raster was introduced into the app by this extension.

Historical validation, as recorded in [PARITY.md](../PARITY.md):

- `e2e-parity-complete-2-light.xcresult`: 40 passed (20 unit/integration and 20 UI), with no failures or skips.
- `parity-review-light.xcresult`: both post-fix UI tests passed, covering settings/presets/number keys and create/error/retry/rename/cancel/end.
- `parity-review-dark.xcresult`: 11 of 12 passed. The management test stopped because the harness did not scroll to the offscreen Rename menu item. After correcting the helper, `parity-management-dark.xcresult` passed the remaining workflow. All 12 dark/maximum-text workflows were verified on that pass's final product source across these two bundles; the 11/12 bundle is not a clean full-suite pass.
- Root lint and typecheck passed. All 1,859 Bun tests passed with zero failures; the full repository test command exited successfully.

Result bundles remain on the Simulator host under `ios/evidence/`.

The finish reviewer inspected 41 initial captures and identified number-key overlap at maximum text and low-contrast tinted preset subtitles. Fixes add a scrollable, spaced number grid with bounded glyph scaling and 500-point/large detents, and explicit primary preset label/command text. After four affected-screen recaptures, both findings were scored **resolved**, with **ship** limited to that fix list.

A later test exposed create-server-error visibility below the current scroll position. The form now scrolls to its error row. The reviewer inspected final light and maximum-text dark `actions-error` captures and scored **resolved/ship** for error visibility; the management end-to-end workflow also passed. These verdicts cover the reviewed corrections, not physical-device certification.

Current validation is limited to the m5p iPhone Simulator. Physical installation/signing is deferred. IME, VoiceOver, real-device performance and successful SSH-host attachment remain unverified. Manual dragging and share-sheet destinations were not independently exercised. Successful live GitHub CI retrieval is not claimed; check states use deterministic fixtures. Historical Tailscale attachment evidence below is separate from the isolated parity backend and synthetic content fixtures.

## Historical visual spike

- `sessions-light.png`: native session list.
- `terminal-light.png`, `terminal-dark.png`: xterm with native navigation and quick keys.
- `terminal-keyboard.png`: software keyboard and accessory strip.
- `terminal-arrows.png`: native directional-key popover.
- `sessions-large-dark.png`: XXXL Dynamic Type list.
- `live-shell.png`, `live-shell-keyboard.png`: real isolated shell output after native typing and Enter.
- `hot-reloaded.png`: temporary title suffix injected without relaunch. PID remained 37100. The suffix is not in final source.

Hot-reload console evidence:

```text
InjectionNext: arm64 iPhoneSimulator connected to app, waiting for commands.
[TerminalScreen.swift] Recompiling (SDKs/iPhoneSimulator)
Compiled in 280ms
Hot reload complete - Rebound 9 symbols, classes []
```

The initial review identified insufficient contrast in colored status text. The final implementation keeps semantic primary text and colors only the adjacent symbol. A separate finish review covers the recaptured affected screens.

Final finish-review verdict: ship the visual spike. The reviewer rechecked all eight refreshed screenshots and marked the sole material contrast finding resolved. This verdict does not cover production parity, Tailscale connectivity, or physical-device usability.

## Historical keyboard iteration

The `feat/ios-keyboard-spike` iteration replaces terminal-light, terminal-keyboard, terminal-arrows, live-shell, and live-shell-keyboard with current captures. `keyboard-before.png` preserves the original two-row layout. Dark-mode, large-type, and hot-reload captures above remain historical evidence from the first spike.

- `native-control-bytes.png`: the shell received Ctrl-C, Tab, Escape, Up, backspace, Enter, and UTF-8 é as the expected byte sequence.
- `native-paste.png`: the tested single-line paste waited for Enter; the keyboard returned after the sheet closed.
- `terminal-scroll-keyboard.png`, `terminal-keyboard-repeat.png`: scrolling and repeated dismissal/reopening.

All five XCTest UI tests passed on the simulator above. The result bundle is `keyboard-connected.xcresult` in the remote keyboard worktree's evidence directory. A fresh finish reviewer inspected the current captures and source and returned **ship this keyboard iteration as a visual/interaction spike**, with no required implementation fix. This does not certify physical devices, IME composition, VoiceOver, multiline paste, or every device size.

## Historical live-session slice

Current live captures come from `live-verified.xcresult` on the same m5p simulator: `live-catalog.png`, `live-terminal-keyboard.png`, `live-resumed.png`, and `live-second-session.png`. They use two disposable zsh windows on a real Agentboard backend with a private tmux socket and data directory. Repeated command markers are intentional test history. `live-invalid-address.png` comes from the later contrast correction in `live-contrast.xcresult`. No production session transcript is committed.

Validation on m5p:

- `live-final.xcresult`: 13 passed, 1 optional tailnet test skipped.
- `live-tailnet.xcresult`: 6 passed, including the explicit read-only Tailscale attachment.
- `live-verified.xcresult`: 8 passed after the event decoder was changed to ignore unrelated event payloads (6 unit, 2 live UI).
- `live-contrast.xcresult`: 1 validation UI test passed after the contrast fix.
- Root lint/typecheck and full tests passed with Bun 1.3.14 and `LOG_LEVEL` unset: 1,859 Bun tests plus Node installer checks. The remote PATH includes `/usr/sbin` for the reaper test's `lsof` query. Local pre-commit checks reached a macOS PTY resource failure, so the matching checks were completed remotely before committing with a one-command hook override. Repository hook settings were not changed.

These results do not certify signing/installation on a physical iPhone, IME, VoiceOver, multiline paste, all orientations or live dark-mode/Dynamic-Type rendering.

The finish reviewer requested primary validation text with a red symbol. After recapture, the reviewer scored that sole fix resolved and returned **ship**, at the scope of the contrast correction.
