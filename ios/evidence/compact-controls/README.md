# Native compact controls evidence

Actual iPhone 17 Pro Simulator captures on iOS 26.5. These PNGs are unchanged XCTest attachments. `provenance.json` maps each image to its exported attachment and capture metadata.

Final visual sources:

- `/tmp/ab-compact-light-final.xcresult`: single-row workflow passed at standard text in light appearance.
- `/tmp/ab-compact-dark-final.xcresult`: both compact workflows passed at maximum accessibility text in dark appearance.

Additional passing runs:

- `/tmp/ab-compact-light2.xcresult`: compact input/rotation workflow plus existing sample navigation and repeated keyboard-transition workflows; 3 UI tests passed.
- `/tmp/ab-compact-shell.xcresult`: 5 modifier/media-count unit tests and 4 UI tests passed. UI coverage includes direct Number keys/Attach/Select destinations, real isolated-shell typing, raw control bytes, and paste waiting for explicit Enter.

The compact workflow asserts that dragging the strip sends no input, Delete word/Shift-Tab/Control-C/newline deliver expected bytes, keys retain minimum 44-point targets, the strip stays 44 points high, keyboard hide/reopen and rotation work, and media remains accessible. Selection destination navigation is checked; this fixture does not certify snapshot retrieval or clipboard copying. Existing menu actions remain in place.

The first light attempt failed because XCTest tried to resolve an offscreen key's hit point after rotation. UI tests now reveal strip keys before tapping their verified centers. Assertions were retained. Subsequent runs passed.

Visual review found a truncated Ctrl C label and oversized maximum-text pills. Keys now allow intrinsic width above 44 points. Compact pill typography caps at .xxxLarge and exposes full summaries through accessibility labels and native Large Content Viewer; destination text stays uncapped. All ten corrected captures received the scoped ship verdict.

Xcode emitted a UIKitToolbar hosting warning in existing sheet flows. Test workflows passed. Diagnostic collection stalled after some passing runs; only the owned diagnostic subprocesses were terminated, allowing Xcode to finalize successful result bundles. No test runner was stopped mid-test.

This evidence does not certify physical iPhone ergonomics, VoiceOver, IME, Large Content Viewer interaction, or full-app parity/hosted CI.

Repository checks: lint and typecheck passed. The first full Bun run passed. A repeat during Simulator work hit the unchanged terminalRelay cleanup assertion (a grouped session still existed after its fixed 100ms wait). The isolated rerun passed all 6 relay tests after Simulator shutdown; no backend source or timing assertion was changed.
