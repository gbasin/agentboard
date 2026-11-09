# Native parity working notes

This is a running record, not an approved feature plan. Implementation follows the agreed PWA parity scope and native glass direction. An observation here does not authorize changing product behavior.

## 1. Parity we may want to reconsider

- **Idle editor versus startup activity:** the real Codex fixture showed Working while MCP startup was running, although no prompt had been submitted. Native uses the shared backend status. Consider distinguishing startup from requested agent work rather than changing native status independently.

- **Lifecycle marker ambiguity:** a live session can retain `isHibernating=true` after Wake. The PWA uses live registry membership and wire status; native previously treated the marker as Sleeping and disabled entry. Fix native decoding, not the shared marker. A clearer API distinction between dormant state and persisted lifecycle intent would prevent this mistake.

- **Frozen selection copy shaping:** the PWA heuristically rejoins agent-wrapped lines and removes shared indentation. It improves prose copying but can join an intentional line break. Preserve its documented behavior for parity; consider an explicit exact-text option for code/data.
- **Autocorrect in a terminal:** helpful for natural-language agent prompts, risky for shell commands, paths and identifiers. Expose a device preference and preserve control-key/composition semantics; do not silently reinterpret committed command text.
- **Status peek:** the PWA spends terminal width on a narrow colored strip. The native app already has a session switcher. A native status summary can expose the same information without copying that geometry.
- **Unicode replacement edits:** terminal applications disagree about deleting composed emoji and combining marks. Native input follows the PWA’s code-point DEL count; verify real agent editors and IMEs on device before treating this as universally correct.
- **HTML attachments:** the server intentionally serves some HTML as downloads. Native source preview and file sharing preserve that contract; rendering downloaded HTML as trusted app content would change it.

## 2. Improvements to strengthen existing behavior

- At maximum Dynamic Type, the terminal action menu needs several scroll gestures to reach lifecycle actions. Consider grouping actions or a dedicated action sheet after parity; keep every action available and avoid shrinking accessibility text.

- Slow discovery currently shows both “Discovering media…” and “Loading media…” while keeping existing items visible. Consider one progress message so the first screen carries more content, especially at maximum Dynamic Type.

- Very long session names at maximum Dynamic Type can crowd the navigation title and chevron. The real image-acceptance capture makes this visible; consider a clearer truncation or wrapping policy in a later design pass.

- Preserve pending attachment review when entering read-only selection. Blocking terminal input should not discard an attachment draft; interrupted uploads remain retryable.
- Keep snapshot requests tied to the selected session and connection generation; reject late replies and prevent hardware/software input from reaching the terminal while selection is open.
- Show thumbnails and individual removal before attachment insertion. Preserve original upload bytes and make the remaining selection obvious.
- Add native build/tests to CI so green web/backend checks cannot be mistaken for a validated Swift build.
- Run repository checks without inherited `LOG_LEVEL=debug`: the logger default test reads cached startup configuration, so that environment makes its default-info assertion fail. This is a test isolation issue, not a Swift behavior change.
- Treat passing taps as insufficient visual evidence. The first maximum-text captures had broken button words and truncated filenames despite passing tests; accessibility layouts now stack actions and scroll previews instead of shrinking text.
- Use one attachment review surface at a time. Rendering the same controller beneath a presented upload sheet exposed duplicate accessibility controls; hide the underlying review while the sheet owns it.
- Landscape keyboard space is a hard constraint: a second status/media row reduced the terminal to 8 points. Move those same controls into native navigation in compact height; verify both media-rich and shell sessions with the keyboard open.
- Fixture/log replacement can temporarily leave old media URLs in the index; digest checks correctly reject those bytes until discovery refreshes. Consider refreshing catalog metadata when a document retry receives a stale-item response, rather than retrying an obsolete URL indefinitely. This was observed while rewriting a private fixture, not normal append-only logs.
- Long creation forms can retain the keyboard while scrolling at maximum text size. Consider a consistent Done/on-submit affordance after parity; do not add redundant keyboard controls without testing the existing dismissal behavior.
- A hosted failure capture exposed a portrait media count wrapping “90” into two lines. The existing ViewThatFits summary must reject compressed detail layouts and use its compact total; preserve all counts in the accessibility label.
- Keep error recovery actions visible at maximum Dynamic Type; lazy native rows require scrolling in tests, not smaller product text.

## 3. Possible gaps or additional features

- Shipping identity: the Simulator home screen still shows a placeholder app icon, and the Xcode targets retain the Spike name. Plan a proper app icon and release identity before distribution; these do not affect PWA functionality.

- Camera-photo formats: the shared image endpoint accepts PNG, JPEG, GIF and WebP. Verify HEIC photo selection on a physical iPhone and decide whether unsupported formats should remain files or offer explicit conversion.
- Exact-copy versus readable-copy option for terminal snapshots.
- On-device VoiceOver, IME and hardware-keyboard acceptance matrix.
- Physical-device share-destination and real-agent image acceptance checks.
- Live GitHub checks on m5p are blocked by its existing invalid `gh` login token (confirmed with `gh auth status`); the native backend returns `error: unavailable`. Re-authenticate on that host before using it for live PR/CI retrieval. Live native retrieval has now passed through this Mac’s already-authenticated backend; m5p’s credential state remains unchanged.
- Slow progressive-media discovery fixture, including cancellation, reconnect and large logs.
- **Implemented in the approved flow refinement:** file/photo and clipboard review now use explicit “Insert attachments,” which uploads and inserts without Enter. Additional file/photo selections preserve the current draft. During attachment review, the file/photo sheet has one Cancel action; clipboard review retains its inline Cancel.

## Decision log

- 2026-11-08: User requested this running record while completing parity. No additional feature above has been independently approved merely by its inclusion here.
- 2026-11-08: Frozen selection now has native selection, shared PWA copy shaping, Refresh and Done. Keyboard autocorrect is a device preference. Seven focused Swift tests and two light Simulator workflows passed; the initial dark/large selection workflow also passed. The combined final matrix remains in progress. This does not establish full app parity.

- 2026-11-08: All 2,581 Bun tests passed on m5p with lint and typecheck. Local checks hit the private relay timeout; the remote pre-commit run passed too. Commit `2500993` is pushed to the draft PR. Attachment review/removal and native status overview have passing light-mode workflows; all five new workflows also passed dark/large checks. Screenshot review found layout corrections now being revalidated; native CI execution remains pending.

- 2026-11-08: Native unit/integration checks now pass 70/70. Review drafts survive frozen selection while insertion remains blocked; initial snapshot scrolling now uses a character target after layout. Settings search uses native Close to leave search before Done dismisses the sheet. Both settings checks and active-selection captures passed in light and maximum-text dark. The scoped independent finish review returned ship for these additions; the fresh full Simulator matrix is running.

- 2026-11-08: The broad light run passed 71 native tests and 32 UI workflows, found the landscape-height regression, and skipped the opt-in tailnet test. The rotation fix and explicit read-only tailnet-address check passed targeted reruns. Both landscape workflows passed in light and dark/maximum text; the scoped visual review returned ship. The full dark matrix is running.

- 2026-11-08: The broad dark/maximum-text run passed 23/26 UI tests. Its three failures were test navigation: offscreen media rows and scrolling a form behind the keyboard. Both media workflows passed after catalog search; creation/duplicate/hibernate, settings/destinations, and file/photo insertion passed together after separating form scrolling from context-menu actions (4/4). Product behavior was unchanged by these harness corrections. All six affected light workflows also passed together: creation/duplicate/hibernate, settings/destinations, file/photo insertion, media search/paging and live activity. Hosted native CI remains pending.

- 2026-11-08: Hosted native CI completed: 71 unit tests passed; light UI had two failures during terminal startup. WebView existence preceded terminal readiness, and the menu helper scrolled past its target during the startup update. Readiness waits and directional menu scrolling are being validated. Split light/dark into independent CI jobs because build plus light alone took approximately 53 minutes; a 60-minute combined job cannot reliably finish both.

- 2026-11-08: Both hosted-failure scenarios passed light checks after readiness synchronization. Dark creation required restoring short menu drags; the corrected creation workflow and media workflow passed separate dark runs. Final light rerun passed both together. Media digits no longer wrap; independent review approved light/dark portrait and landscape captures. Real-backend PDF download, Quick Look eligibility, temporary-copy cleanup and the Library HTML/PDF/link workflow passed in light and dark/maximum text. PDF is visibly rendered in both captured appearances; physical sharing and other file formats remain unverified.

- 2026-11-08: A real read-only SSH-backed attachment passed over the cross-host Tailscale route: m5p Simulator → this Mac’s isolated backend → SSH to m5p’s private tmux socket. No terminal input or metadata changes. See `evidence/ci-finish/ssh-attach.md` for isolation and limits. Successful SSH attachment is now verified for this topology.

- 2026-11-08: Final full native unit/integration run passed 72/72 after updating the older media-count assertion for the added PDF fixture. The PDF workflow passed both appearances, and the real SSH-backed read-only attach passed separately. Hosted native CI still needs a successful run.

- 2026-11-08: Live native GitHub retrieval passed through `http://100.82.11.20:4040`: opened PR #530 directly from the selected session’s catalog PR control, asserted its real title and check name, and captured actual statuses. No terminal was opened and no metadata, settings or credentials changed. This closes live native GitHub retrieval for the authenticated backend; m5p’s invalid gh token remains a host-specific issue.

- 2026-11-08: Real Codex CLI image-editor acceptance passed through native clipboard review/upload/insertion, without submitting a prompt. PDF Save to Files completed and the saved 666-byte PDF matched the source SHA-256. This does not certify model-side image interpretation, other agent editors, or other share destinations.
- 2026-11-08: The large real-transcript test exposed a discovery parity gap missed by the small fixture: the PWA renews incomplete finite streams up to three times, while Swift required manual continuation. Bounded automatic renewal and foreground continuation are fixed in `6d2e781`. All 76 native tests passed, and the real 500,001-item discovery/background-recovery workflow passed light and dark/maximum text. Keep the existing visible page fixed while receiving newer discovery metadata.

- 2026-11-08: Hosted run `42514977955` passed 76 native and 34 light UI tests. Dark passed 24/26; a clipped menu target and leftover shell command caused the two failures. Shared menu navigation now uses enclosing popup bounds; rotation cancels unfinished input through native Control-C. All three corrected dark workflows passed together. Full hosted verification of these test changes is pending.

- 2026-11-08: Hosted run `42519493436` lost its light fixture backend before tests: Bun 1.3.14 reported a segmentation fault after high host load during the build. This caused 10 native and 20 UI connection failures. The sharded workflow builds before starting fixture services and checks process/backend health before testing. This reduces contention and wasted failures; it does not establish that the Bun runtime defect is fixed.

- 2026-11-08: The first five-shard run (`42521922736`) exposed two terminal-readiness failures: catalog dark exceeded its 10-second deadline, while lifecycle light failed during severe runner load (load1 369 on three CPUs, with tmux timeouts). Lifecycle dark passed. Catalog now uses the existing 20-second readiness helper; all seven catalog workflows passed together on m5p in dark/maximum text. Cold Simulator boot now precedes fixture startup. This limits startup contention; it does not prove hosted reliability or a fixed runtime. Each appearance uploads its results immediately for diagnosis.

- 2026-11-08: First shared-build/five-shard hosted run completed in 31m48s: 76/76 native, 33/34 light UI, 23/26 dark UI passed. Settings passed both appearances. The other dark failures were a stale indexed navigation bar during Quick Look dismissal and an offline connection-button tap that did not open the sheet. Preview tests now wait for dismissal before reading list geometry. The offline test passed three unchanged dark/maximum-text repeats on m5p; its hosted failure remains unresolved, and failure screenshot/hierarchy capture was added. No retry tap or skipped assertion was introduced.

- 2026-11-08: User approved the flow-study direction and asked that recovery reminders remain easy to dismiss. Native refinement keeps dismissal local and scoped to the known interruptions on each server; it does not archive or resume sessions. Compact catalog spacing preserves metadata actions and ordering. Library separates Recovery, Saved, and History, with filters in a sheet. File/photo selections now join one explicit Insert attachments review, matching clipboard insertion without submitting Enter. Focused Simulator validation passed on branch feat/ios-flow-refinement; this entry is not a full-parity signoff.

- Flow-refinement review found two issues beyond passing taps: Photos retained its old picker selection when adding more attachments, and maximum Dynamic Type could render Recovery’s Resume action as an unreadable tall button. Picker selections now reset after consumption; the regression selects twice, verifies exactly two review items, removes one and inserts the other. Accessibility recovery actions now stack explicitly with wrapping labels. Native menu taps use the verified position anchored to the app, avoiding XCTest re-querying a disappearing menu button. Final dark and light repeat-selection runs passed. At the absolute maximum Dynamic Type size, “Insert attachments” still hyphenates even with a full-width rectangular control. It remains readable; consider a shorter visible action label with the full accessibility label in a later copy pass.

- Final flow-refinement validation: 21 focused native tests passed; catalog/navigation, recovery dismissal, saved detail/transcripts, file insertion and photo insertion passed light/standard and dark/maximum-text workflows. Repeated Photos selection passed in both appearances. Final repository checks passed lint, typecheck and all 2,581 Bun tests. Independent native finish and documentation reviews returned ship at this scope. Evidence: `ios/evidence/flow-refinement/`. Physical-device acceptance and full-app hosted CI remain separate gates.

## Compact native terminal controls

- User decision: preserve terminal reading space with one horizontally scrolling quick-key row. The two-row proposal was rejected. Keep the first ten controls in PWA order; additional shortcuts follow them.
- Improvement implemented: Select, Delete word, Number keys, separate Shift, Copy, Interrupt, Newline and Attach are reachable from the strip. Existing menu destinations remain. Status/media pills use smaller native glass surfaces while retaining at least 44-point targets.
- Tradeoff to watch: keyboard dismissal and later shortcuts require horizontal scrolling on portrait iPhone. Keep order stable; do not add a permanent second row to solve discoverability.
- Follow-up: physical touch/VoiceOver acceptance remains needed. This Simulator pass does not certify IME or every iPhone size. Xcode also emitted a UIKitToolbar hosting warning while opening existing sheet flows; those workflows passed, but retain it as a platform follow-up.

## 2026-11-09 release follow-up

- Validation gap: Files folder activation stalls in iOS 27.2 Simulator, including a standalone system-picker reproduction. Preserve the native picker; do not redesign it to satisfy automation. Confirm select → review → insert on the phone. See [RELEASE-VALIDATION.md](RELEASE-VALIDATION.md).
- Improvement: keep test queries aligned with native semantics. External destinations are links, quick keys scroll horizontally, and maximum-text edit menus expose Next Page. These corrections preserve product behavior and assertions.
- Infrastructure gap: standard hosted CI passes, but native fixture warm-up still fails under extreme hosted runner load. Startup probing alone does not establish sustained runner health. Retain diagnostics and resolve runner capacity/startup separately from product parity.
