import XCTest

/// Replace iPhone field text through the native edit menu, not hardware-key shortcuts.
extension XCUIElement {
    /// Whether this element or a descendant owns keyboard focus, read from a
    /// fresh snapshot. The private `hasKeyboardFocus` KVC key reported false on
    /// Xcode 27.2 while the same element's description said "Keyboard Focused".
    /// typeText accepts focus on a descendant, so check the whole subtree.
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
    @discardableResult
    func focusForTyping(timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !hasKeyboardFocus {
                guard waitForExistence(timeout: max(0.1, deadline.timeIntervalSinceNow)) else { break }
                tap()
            }
            let focused = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.hasKeyboardFocus }, object: nil)
            if XCTWaiter.wait(for: [focused], timeout: min(3, max(0.1, deadline.timeIntervalSinceNow))) == .completed {
                waitForStableFrame(until: deadline)
                return true
            }
        }
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

    func replaceNativeText(with value: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        guard focusForTyping(file: file, line: line) else { return }
        let current = self.value as? String
        if current != "" && current != placeholderValue {
            // A second tap at the insertion point opens edit options; a hold
            // moves the caret and can leave the edit menu closed.
            tap()
            let menuReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let selectAll = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
                let forward = app.buttons.matching(NSPredicate(format: "label IN %@", ["Forward", "Next Page"])).firstMatch
                return (selectAll.exists && selectAll.isHittable)
                    || (forward.exists && forward.isEnabled && forward.isHittable)
            }, object: nil)
            guard XCTWaiter.wait(for: [menuReady], timeout: 5) == .completed else {
                XCTFail("The native edit menu did not appear.", file: file, line: line); return
            }
            var selection: XCUIElement?
            // Accessibility text sizes paginate the edit menu. Require each
            // Forward / Next Page action to reveal a different page before continuing.
            for _ in 0..<8 {
                let selectAll = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
                if selectAll.exists && selectAll.isHittable { selection = selectAll; break }
                let forward = app.buttons.matching(NSPredicate(format: "label IN %@", ["Forward", "Next Page"])).firstMatch
                guard forward.exists && forward.isEnabled && forward.isHittable else { break }
                let previous = app.menuItems.allElementsBoundByIndex.map(\.label)
                forward.tap()
                let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    let labels = app.menuItems.allElementsBoundByIndex.map(\.label)
                    let expandedSelection = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
                    return (expandedSelection.exists && expandedSelection.isHittable) || (!labels.isEmpty && labels != previous)
                }, object: nil)
                guard XCTWaiter.wait(for: [changed], timeout: 5) == .completed else {
                    XCTFail("The native edit menu did not advance.", file: file, line: line); return
                }
            }
            guard let selection else {
                XCTFail("The native edit menu did not offer Select All.", file: file, line: line); return
            }
            selection.tap()
            typeText(XCUIKeyboardKey.delete.rawValue)
        }
        let cleared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let current = self.value as? String else { return false }
            return current.isEmpty || current == self.placeholderValue
        }, object: nil)
        guard XCTWaiter.wait(for: [cleared], timeout: 5) == .completed else {
            XCTFail("The native field did not clear.", file: file, line: line); return
        }
        typeText(value)
        XCTAssertEqual(self.value as? String, value, file: file, line: line)
    }
}
