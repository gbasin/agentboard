# iPhone parity implementation

The native iPhone client implements the PWA workflows at repository reference `74ed561`. Presentation follows PRODUCT.md and DIRECTION.md. Validation uses the m5p iPhone 17 Pro Simulator, iOS 26.4, and an isolated real backend. Physical-device installation remains deferred by the user.

| Area | Implemented behavior | Automated evidence |
|---|---|---|
| Connection | address validation, prefix URLs, reconnect, suspend/resume, remote capabilities | connection unit tests; live shell, switching and background recovery |
| Catalog | search, status/project/host filters, sort/direction/manual order, row preferences | search and preference persistence UI; shared-settings roundtrip |
| Create | directory browser, recent paths, host picker, presets/defaults, command, optional name, duplicate | directory navigation, create/duplicate UI and invalid-directory recovery |
| Lifecycle | rename, confirmed end, hibernate, wake, move to history | real backend API and UI workflows |
| Library | paged/searchable/filterable saved sessions, pin, rename, resume, archive, recovery, preview/events | saved-session API and UI; pin, resume, archive and provider lifecycle |
| Conversations | inactive/hibernating logs, resume, transcript messages/events and older pages | shared parser, line/byte pagination and transcript UI |
| Media | images/documents/links, pinch zoom, detail navigation, external links, sharing | actual image bytes, document rendering and media navigation UI |
| Pull requests | title/state/author, draft status, CI details, open/share links | unavailable state and deterministic passed/running/failed checks UI |
| Files | native file/photo pickers, upload, quoted-path insertion without Enter, errors | real picker → upload → shell insertion workflows |
| Terminal | native input, safe paste, arrows/numpad/control, typography/renderer, scrollback, selection/clipboard, copy-mode exit, links | raw control/UTF-8 bytes, single/multiline paste, number keys, clipboard scoping, scroll, keyboard and rotation |
| Settings | shared preferences, presets CRUD/default, theme, row details, server controls/history, persistence, device rendering, sounds | queued writes and server roundtrips; preset creation, search and relaunch persistence UI |

The evidence column names exercised workflows; it does not claim an automated assertion for every control or external service. Manual dragging, share-sheet destinations and successful SSH-host attachment are implemented but not independently exercised by this fixture matrix. Browser shortcut-modifier and web install/service-worker controls are platform-specific; iPhone uses native navigation, keyboard input and app installation. The desktop sidebar anchor remains editable as a shared preference.

## Final validation

- Repository lint and typecheck passed. All **1,859 Bun tests** passed, with zero failures; the complete repository test command exited successfully.
- **40 tests passed** in the full light/standard run: 20 native unit/integration tests and 20 UI tests. Result: `e2e-parity-complete-2-light.xcresult`.
- The final presentation/error-recovery changes passed a **2-test light rerun**: settings/presets/number keys and create/error/retry/rename/cancel/end. Result: `parity-review-light.xcresult`.
- All **12 dark/maximum-accessibility-text workflows are verified** on the final app code. `parity-review-dark.xcresult` passed 11; its management test stopped at an offscreen Rename menu item. The harness was corrected to scroll the native menu, and `parity-management-dark.xcresult` passed that remaining workflow. The 11/12 bundle is not represented as a clean full-suite pass.
- Native unit/integration coverage includes real saved-session hibernate/resume/archive, provider rename/wake/hibernate/history, directory errors, shared settings, queued writes, server toggles, recovery settings, transcript pagination, image decoding and multipart upload.
- A fresh UI reviewer inspected 41 initial captures. Number-pad overlap and preset subtitle contrast were corrected and scored **resolved**, with a **ship** verdict limited to those fixes. The subsequent create-error visibility correction was separately scored **resolved/ship** in light and maximum-text dark captures. These are scoped review verdicts, not physical-device certification.

Run the repeatable matrix with `./ios/scripts/test-e2e.sh YOUR_UDID` after preparing the fixtures in [README.md](README.md). Result bundles remain on the simulator host under `ios/evidence/`; PNG evidence is committed in [parity-light](evidence/parity-light/) and [parity-dark](evidence/parity-dark/).

Representative views: [terminal](evidence/parity-light/live-terminal-keyboard.png), [saved session](evidence/parity-light/parity-saved-detail.png), [settings](evidence/parity-light/parity-settings.png), [PR checks](evidence/parity-light/parity-pull-request-checks.png), [large-text number keys](evidence/parity-dark/parity-number-keys.png).

## Integration boundary

Tests use disposable shells, a private tmux socket/data directory and a shell-only provider-resume template. Production sessions are not mutated. Ports 4151 and 4149 provide the real backend and raw-shell fixtures. Port 4190 proxies the backend while supplying deterministic GitHub metadata; successful live GitHub CI retrieval is not claimed.

Physical iPhone signing/installation, IME, VoiceOver, real-device performance and successful SSH-host attachment remain unverified. The app uses the user's existing Tailscale connection; it does not configure Tailscale. The live client uses the existing server contracts.
