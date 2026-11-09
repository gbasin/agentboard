# iPhone parity implementation

Latest audit and remote regression: [READINESS-AUDIT.md](READINESS-AUDIT.md). Current baseline is `35483b5`, with frozen native selection, terminal autocorrect, attachment preview/removal, and cross-session status overview added. Running product observations: [PARITY-NOTES.md](PARITY-NOTES.md). The results below describe earlier checkpoints.

The native iPhone client targets the PWA behavior at repository reference `74ed561`. This document separates implemented behavior from exercised workflows; it is not a certification of complete functional parity. A subsequent source audit found five omissions in the earlier broad parity claim. The corrections and their evidence are recorded below. Presentation follows PRODUCT.md and DIRECTION.md. Historical validation below used the m5p iPhone 17 Pro Simulator, iOS 26.4, and an isolated real backend. Physical-device signing, TestFlight installation and connection were confirmed for build 2 on 2026-11-09; see [TESTFLIGHT.md](TESTFLIGHT.md).


Current local integration adds the media catalog and live activity contract from backend reference `0e204cf`. See [MEDIA-INTEGRATION.md](MEDIA-INTEGRATION.md) for current validation and remaining limits. Earlier results below are historical; they do not certify this newer backend as a whole.

| Area | Implemented behavior | Automated evidence |
|---|---|---|
| Connection | address validation, prefix URLs, reconnect, suspend/resume, remote capabilities | connection unit tests; live shell, switching and background recovery |
| Catalog | search, status/project/host filters, filter-option search and host status, active-filter count, hidden-approval notice, sort/direction/manual order, row preferences | search and preference persistence UI; shared-settings roundtrip |
| Create | directory browser, recent paths, host picker, presets/defaults, command, optional name, duplicate | directory navigation, create/duplicate UI and invalid-directory recovery |
| Lifecycle | rename, confirmed end, hibernate, wake, move to history | real backend API and UI workflows |
| Library | paged/searchable/filterable saved sessions, pin, rename, resume, archive, recovery, preview/events | saved-session API and UI; pin, resume, archive and provider lifecycle |
| Conversations | inactive/hibernating logs with shared project/host filters, resume, transcript messages/events and older pages | shared parser, line/byte pagination and transcript UI |
| Media | images/documents/links, pinch zoom, detail navigation, external links, sharing | actual image bytes, document rendering and media navigation UI |
| Pull requests | title/state/author, draft status, CI details, open/share links | unavailable state and deterministic passed/running/failed checks UI |
| Files | multi-selection native file/photo pickers, public clipboard images/files, upload queue/retry, quoted document paths and agent-specific image input without Enter | real picker → upload → shell insertion workflows |
| Terminal | native input, safe paste, arrows/numpad/control, typography/renderer, scrollback, selection/clipboard, copy-mode exit, links | raw control/UTF-8 bytes, single/multiline paste, number keys, clipboard scoping, scroll, keyboard and rotation |
| Settings | shared preferences, presets CRUD/default, theme, row details, server controls/history, persistence, device rendering, sounds | queued writes and server roundtrips; preset creation, search and relaunch persistence UI |

The evidence column names exercised workflows; it does not claim an automated assertion for every control or external service. Manual dragging and persistence after relaunch passed a targeted Simulator workflow. Actual share-sheet destinations and successful SSH-host attachment remain unverified. Browser shortcut-modifier and web install/service-worker controls are platform-specific; iPhone uses native navigation, keyboard input and app installation. The desktop sidebar anchor remains editable as a shared preference.

## Parity-gap corrections

The source corrects the five audited omissions against PWA reference `74ed561`:

| Gap | Implemented behavior |
|---|---|
| Clipboard and upload delivery | Public `UIPasteControl` with asynchronous text/image/file providers; native edit-menu paste; multi-file/photo selection; FIFO paste queue; retry of remaining uploads; current-agent image formatting; stale-owner cancellation; no implicit Enter |
| Shared history filters | Project/host selections apply to active sessions, hibernating conversations and conversation history; choices include dormant/configured/selected values, option search and offline-host details |
| Hidden approval visibility | Active-filter count and an actionable notice that clears filters/search obscuring approval requests |
| Remote management capabilities | Remote Rename, Duplicate and End require a managed source and server control capability; remote Hibernate is unavailable |
| Proactive recovery | Catalog notice for interrupted sessions/recovery errors; foreground polling and library-change refresh; per-server dismissal; review opens Library's Recovery scope |

### Verified results

| Result bundle or check | Result and scope |
|---|---|
| `gaps-public-paste-light.xcresult` | 43 native unit/integration tests passed; six of eight UI workflows passed: all five gap workflows plus file-picker upload |
| `gaps-clipboard-photo-light.xcresult` | Clipboard UI workflow passed after checking joined xterm accessibility rows; photo confirmation selector failed |
| `gaps-finish-light.xcresult` | Three of three UI tests passed: photo upload, hidden approval and recovery |
| `gaps-dark-max.xcresult` | Initial run exited 65; seven explicit control-location failures retrieved, eighth result unavailable |
| `gaps-dark-max-scroll.xcresult` | Three of eight UI workflows passed: clipboard, file upload and photo upload; five catalog workflows failed on test navigation |
| `gaps-dark-gap-navigation.xcresult` | Four of five passed: hidden approval, manual ordering, recovery and remote capabilities; filter navigation failed |
| `gaps-dark-filter-visible.xcresult` | Filter/history workflow passed, one of one (32.084 seconds) |
| `gaps-dark-recovery-row.xcresult` | Recovery-row capture test passed, one of one (19.992 seconds) |
| Repository checks | Lint, typecheck and 1,859 Bun tests passed |
| Image-upload byte check | The real backend's generated image matched the original 319-byte PNG and SHA-256 |

**All eight affected UI workflows are verified in light/standard-text and dark/maximum-text appearances across separate runs.** Partially failed bundles remain recorded as failures. Test corrections use visible native containers/rows and normal scrolling; they do not change product behavior. The 43 native tests include 16 clipboard/provider/controller tests, five catalog-policy tests and two recovery-model tests.

### Visual evidence and limits

[gaps-light](evidence/gaps-light/) contains **18 captures**, including refreshed contrast views and successful clipboard/photo evidence. Review of all 18 found no new issues and scored both contrast corrections resolved. [gaps-dark](evidence/gaps-dark/) contains **20 captures from passing workflows**. The reviewer inspected all 18 light and 20 dark captures and returned **ship this scoped parity-fix UI**, with both contrast corrections resolved and no further correction required. Five diagnostic captures from the failed initial run remain separately labeled in [gaps-dark-initial](evidence/gaps-dark-initial/).

Simulator light appearance and `large` text size were independently verified. Owned backend, protocol fixture and keep-awake processes were stopped; the private test tmux session was removed. No test runner or port-4151/4192 listeners remained. Proposal hosts were preserved. See [README.md](README.md) for repeatable fixture and test commands.

Source changes are `3761cdc` (clipboard), `f3dc2b6` (filters, remote actions and recovery), and `eb071c4` (explicit primary text for hidden approval and saved-session metadata). Independent source review found no remaining blocking issue in the revised queue, async providers, capability gates or Recovery route. This does not certify full PWA parity, real-agent image acceptance, live SSH/GitHub, physical-device behavior, VoiceOver, IME or actual share destinations.

The corrections preserve the native interface. Separately hosted design proposals are not applied app changes and remain subject to user approval.

## Historical parity validation

- Repository lint and typecheck passed. All **1,859 Bun tests** passed, with zero failures; the complete repository test command exited successfully.
- **40 tests passed** in the full light/standard run: 20 native unit/integration tests and 20 UI tests. Result: `e2e-parity-complete-2-light.xcresult`.
- The final presentation/error-recovery changes passed a **2-test light rerun**: settings/presets/number keys and create/error/retry/rename/cancel/end. Result: `parity-review-light.xcresult`.
- All **12 dark/maximum-accessibility-text workflows are verified** on that pass's final app code. `parity-review-dark.xcresult` passed 11; its management test stopped at an offscreen Rename menu item. The harness was corrected to scroll the native menu, and `parity-management-dark.xcresult` passed that remaining workflow. The 11/12 bundle is not represented as a clean full-suite pass.
- Native unit/integration coverage includes real saved-session hibernate/resume/archive, provider rename/wake/hibernate/history, directory errors, shared settings, queued writes, server toggles, recovery settings, transcript pagination, image decoding and multipart upload.
- A fresh UI reviewer inspected 41 initial captures. Number-pad overlap and preset subtitle contrast were corrected and scored **resolved**, with a **ship** verdict limited to those fixes. The subsequent create-error visibility correction was separately scored **resolved/ship** in light and maximum-text dark captures. These are scoped review verdicts, not physical-device certification.

Run the repeatable matrix with `./ios/scripts/test-e2e.sh YOUR_UDID` after preparing the fixtures in [README.md](README.md). Result bundles remain on the simulator host under `ios/evidence/`; PNG evidence is committed in [parity-light](evidence/parity-light/) and [parity-dark](evidence/parity-dark/).

Representative views: [terminal](evidence/parity-light/live-terminal-keyboard.png), [saved session](evidence/parity-light/parity-saved-detail.png), [settings](evidence/parity-light/parity-settings.png), [PR checks](evidence/parity-light/parity-pull-request-checks.png), [large-text number keys](evidence/parity-dark/parity-number-keys.png).

## Integration boundary

Tests use disposable shells, a private tmux socket/data directory and a shell-only provider-resume template. Production sessions are not mutated. Ports 4151 and 4149 provide the real backend and raw-shell fixtures. Port 4192 is a deterministic loopback-only protocol fixture for filters, capability gating and recovery; it does not connect to tmux, SSH or GitHub. Port 4190 proxies the backend while supplying deterministic GitHub metadata; successful live GitHub CI retrieval is not claimed.

Beyond the build-2 signing, installation and connection checkpoint, physical iPhone acceptance remains open. IME, VoiceOver, real-device performance, successful SSH-host attachment, actual share-sheet destinations, live GitHub retrieval and real-agent image attachment acceptance remain unverified. The app uses the user's existing Tailscale connection; it does not configure Tailscale. The live client uses the existing server contracts.
