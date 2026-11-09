# Native flow refinement evidence

Actual local iPhone 17 Pro Simulator captures on iOS 26.5, November 8, 2026. Test content comes from private fixtures. PNG files are unchanged XCTest attachments; provenance.json records each source export.

Validated workflows:
- Recovery notice opens Recovery, dismisses, stays dismissed across app relaunch, preserves Library access, and reappears for a new interruption.
- Catalog activity, PR/media access, terminal keyboard and Library navigation.
- Saved-session pin/unpin, transcript messages/events and earlier-message loading.
- Files upload and insert into a terminal draft.
- Photos select twice without re-appending previous picker selections, remove the second attachment, then insert the remaining image.

These workflows passed in light/standard text and dark/maximum Dynamic Type across the refinement runs. The final photo regression passed in both appearances; the final accessibility control sizing also passed a dark rerun. NativePasteTests and RecoveryNoticeTests passed 21 focused native tests. The final build-for-testing passed. The repository pre-commit checks passed lint, typecheck and all 2,581 Bun tests after Simulator work finished.

Visual review caught an unreadable maximum-text Resume layout despite passing UI assertions. Explicit stacked actions and wrapping labels corrected it. The attachment action uses full width and a rounded rectangle at accessibility sizes; the long word still hyphenates at the absolute maximum size and remains fully visible. This residual typography limitation is recorded in PARITY-NOTES.md.

An earlier repository run timed out in the private relay test while Simulator was starting under heavy host load. Its focused rerun and the final full checks passed. An earlier photo regression attempt failed during XCTest menu tapping before reaching Photos; app-anchored tapping of the verified menu-item position corrected the disappearing-element query. No assertion was removed or retry-tap introduced.

Review verdict: ship this scoped refinement. This is not a full-app parity certification, physical-device test, or VoiceOver/IME/HEIC acceptance. The source evidence includes standard-size captures taken before accessibility-only sizing fixes; their shown appearance is unchanged by those fixes.

Hosted gallery: http://100.82.11.20:8188/proposals/native/flow-refinement/
