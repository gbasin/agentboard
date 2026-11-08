# Native parity working notes

This is a running record, not an approved feature plan. Implementation follows the agreed PWA parity scope and native glass direction. An observation here does not authorize changing product behavior.

## 1. Parity we may want to reconsider

- **Frozen selection copy shaping:** the PWA heuristically rejoins agent-wrapped lines and removes shared indentation. It improves prose copying but can join an intentional line break. Preserve its documented behavior for parity; consider an explicit exact-text option for code/data.
- **Autocorrect in a terminal:** helpful for natural-language agent prompts, risky for shell commands, paths and identifiers. Expose a device preference and preserve control-key/composition semantics; do not silently reinterpret committed command text.
- **Status peek:** the PWA spends terminal width on a narrow colored strip. The native app already has a session switcher. A native status summary can expose the same information without copying that geometry.
- **Unicode replacement edits:** terminal applications disagree about deleting composed emoji and combining marks. Native input follows the PWA’s code-point DEL count; verify real agent editors and IMEs on device before treating this as universally correct.
- **HTML attachments:** the server intentionally serves some HTML as downloads. Native source preview and file sharing preserve that contract; rendering downloaded HTML as trusted app content would change it.

## 2. Improvements to strengthen existing behavior

- Preserve pending attachment review when entering read-only selection. Blocking terminal input should not discard an attachment draft; interrupted uploads remain retryable.
- Keep snapshot requests tied to the selected session and connection generation; reject late replies and prevent hardware/software input from reaching the terminal while selection is open.
- Show thumbnails and individual removal before attachment insertion. Preserve original upload bytes and make the remaining selection obvious.
- Add native build/tests to CI so green web/backend checks cannot be mistaken for a validated Swift build.
- Run repository checks without inherited `LOG_LEVEL=debug`: the logger default test reads cached startup configuration, so that environment makes its default-info assertion fail. This is a test isolation issue, not a Swift behavior change.
- Treat passing taps as insufficient visual evidence. The first maximum-text captures had broken button words and truncated filenames despite passing tests; accessibility layouts now stack actions and scroll previews instead of shrinking text.
- Use one attachment review surface at a time. Rendering the same controller beneath a presented upload sheet exposed duplicate accessibility controls; hide the underlying review while the sheet owns it.
- Keep error recovery actions visible at maximum Dynamic Type; lazy native rows require scrolling in tests, not smaller product text.

## 3. Possible gaps or additional features

- Camera-photo formats: the shared image endpoint accepts PNG, JPEG, GIF and WebP. Verify HEIC photo selection on a physical iPhone and decide whether unsupported formats should remain files or offer explicit conversion.
- Exact-copy versus readable-copy option for terminal snapshots.
- On-device VoiceOver, IME and hardware-keyboard acceptance matrix.
- Physical-device share-destination and real-agent image acceptance checks.
- Slow progressive-media discovery fixture, including cancellation, reconnect and large logs.
- Attachment review currently has separate Upload and Insert steps for file/photo pickers, while clipboard review inserts after upload. Consider a unified explicit “Insert attachments” flow after parity is established; do not change this during verification.

## Decision log

- 2026-11-08: User requested this running record while completing parity. No additional feature above has been independently approved merely by its inclusion here.
- 2026-11-08: Frozen selection now has native selection, shared PWA copy shaping, Refresh and Done. Keyboard autocorrect is a device preference. Seven focused Swift tests and two light Simulator workflows passed; the initial dark/large selection workflow also passed. The combined final matrix remains in progress. This does not establish full app parity.

- 2026-11-08: All 2,581 Bun tests passed on m5p with lint and typecheck. Local checks hit the private relay timeout; the remote pre-commit run passed too. Commit `2500993` is pushed to the draft PR. Attachment review/removal and native status overview have passing light-mode workflows; all five new workflows also passed dark/large checks. Screenshot review found layout corrections now being revalidated; native CI execution remains pending.

- 2026-11-08: Native unit/integration checks now pass 70/70. Review drafts survive frozen selection while insertion remains blocked; initial snapshot scrolling now uses a character target after layout. Settings search uses native Close to leave search before Done dismisses the sheet. Both settings checks and active-selection captures passed in light and maximum-text dark. The scoped independent finish review returned ship for these additions; the fresh full Simulator matrix is running.
