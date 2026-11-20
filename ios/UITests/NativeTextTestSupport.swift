import XCTest

/// Replace iPhone field text through the native edit menu, not hardware-key shortcuts.
extension XCUIElement {
    /// Whether this element or a descendant owns keyboard focus, read from the
    /// "Keyboard Focused" attribute of a fresh snapshot. Do not use the private
    /// `hasKeyboardFocus` KVC key; it is unreliable on CI. typeText accepts
    /// focus on a descendant, so check the whole subtree.
    var hasKeyboardFocus: Bool {
        guard exists else { return false }
        let description = debugDescription
        guard let start = description.range(of: "Element subtree:") else { return false }
        let end = description.range(of: "Path to element:", range: start.upperBound..<description.endIndex)?.lowerBound ?? description.endIndex
        return description[start.upperBound..<end].contains("Keyboard Focused")
    }

    /// Tap until this field owns keyboard focus, then let it finish moving.
    /// Under CI load a single tap can land before the field accepts focus, and
    /// typeText then fails with "Neither element nor any descendant has keyboard focus".
    /// Poll directly: each focus check takes a full accessibility snapshot, which
    /// can outlast a short XCTWaiter window on a loaded runner.
    @discardableResult
    func focusForTyping(timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        guard waitForExistence(timeout: timeout) else {
            XCTFail("Field does not exist: \(debugDescription)", file: file, line: line); return false
        }
        if !hasKeyboardFocus { tap() }
        var lastTap = Date()
        while Date() < deadline {
            if hasKeyboardFocus { waitForStableFrame(until: deadline); return true }
            // Re-tap only after a long quiet period; a tap on a field that is
            // gaining focus can open the edit menu instead.
            if Date().timeIntervalSince(lastTap) > 8 { tap(); lastTap = Date() }
            Thread.sleep(forTimeInterval: 0.25)
        }
        if hasKeyboardFocus { return true }
        XCTFail("Field did not receive keyboard focus: \(debugDescription)", file: file, line: line)
        return false
    }

    /// Focus the field, then type. Use for native text and search fields.
    func typeIntoField(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        guard focusForTyping(file: file, line: line) else { return }
        typeText(text)
    }

    /// A focused field can still be scrolling above the keyboard; taps on a
    /// moving frame miss. Wait for two equal samples instead of a fixed sleep.
    private func waitForStableFrame(until deadline: Date) {
        var previous = frame
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            let current = frame
            if current == previous { return }
            previous = current
        }
    }

    /// The compact menu shows Select All as a menu item; the paginated menu at
    /// accessibility text sizes shows it as a button. Query both by type: an
    /// untyped descendants query also matches their static-text children and
    /// walks the whole keyboard tree.
    private func hittableSelectAll(in app: XCUIApplication) -> XCUIElement? {
        for candidate in [app.menuItems["Select All"], app.buttons["Select All"]] where candidate.exists && candidate.isHittable {
            return candidate
        }
        return nil
    }

    func replaceNativeText(with value: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        guard focusForTyping(file: file, line: line) else { return }
        let current = self.value as? String
        if current != "" && current != placeholderValue {
            // A second tap at the insertion point opens edit options; a hold
            // moves the caret and can leave the edit menu closed.
            tap()
            // The menu appears after UIKit rules out a double tap. On a loaded
            // runner the first snapshot while it animates in can take over four
            // seconds, so allow several samples rather than one.
            let forwardQuery = app.buttons.matching(NSPredicate(format: "label IN %@", ["Forward", "Next Page"])).firstMatch
            guard waitUntil(timeout: 15, {
                hittableSelectAll(in: app) != nil
                    || (forwardQuery.exists && forwardQuery.isEnabled && forwardQuery.isHittable)
            }) else {
                XCTFail("The native edit menu did not appear.", file: file, line: line); return
            }
            var selection: XCUIElement?
            // Accessibility text sizes paginate the edit menu. Require each
            // Forward / Next Page action to reveal a different page before continuing.
            for _ in 0..<8 {
                if let selectAll = hittableSelectAll(in: app) { selection = selectAll; break }
                guard forwardQuery.exists && forwardQuery.isEnabled && forwardQuery.isHittable else { break }
                let previous = app.menuItems.allElementsBoundByIndex.map(\.label)
                forwardQuery.tap()
                guard waitUntil(timeout: 15, {
                    let labels = app.menuItems.allElementsBoundByIndex.map(\.label)
                    return hittableSelectAll(in: app) != nil || (!labels.isEmpty && labels != previous)
                }) else {
                    XCTFail("The native edit menu did not advance.", file: file, line: line); return
                }
            }
            guard let selection else {
                XCTFail("The native edit menu did not offer Select All.", file: file, line: line); return
            }
            selection.tap()
            typeText(XCUIKeyboardKey.delete.rawValue)
        }
        guard waitUntil(timeout: 5, {
            guard let current = self.value as? String else { return false }
            return current.isEmpty || current == self.placeholderValue
        }) else {
            XCTFail("The native field did not clear.", file: file, line: line); return
        }
        typeText(value)
        XCTAssertEqual(self.value as? String, value, file: file, line: line)
    }
}
