# Session action captures

Origin: unmodified XCTest screenshots from the iPhone 17 Pro Simulator, iOS 26.4, Xcode 26.4 on m5p. These are real native app captures, not generated mockups.

- `*-light.png`: standard text size; `actions-ui-fixed.xcresult`, one end-to-end test passed.
- `*-dark-accessibility.png`: largest accessibility text size; `actions-accessibility-settled.xcresult`, the same test passed.
- Create captures show deliberately invalid directory input. Error captures show the server rejection with the keyboard dismissed. Rename captures show editing. End captures show the confirmation before canceling it. Ended captures show the catalog after confirmed removal.
- At the largest text size, fields scroll horizontally and native forms/menus scroll vertically. The destructive confirmation button is below the fold in the end capture; XCTest scrolled and activated it in the passing run.
- The dark catalog still contains a different disposable shell from an earlier failed test. The uniquely named session created by the passing run was removed. All fixture processes are cleaned up after validation.

These captures validate local session actions only. They do not establish physical-device, VoiceOver, IME or remote SSH parity. Result bundles stay on the Simulator host under `ios/evidence/`.
