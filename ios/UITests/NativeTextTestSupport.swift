import XCTest

/// Replace iPhone field text through the native edit menu, not hardware-key shortcuts.
extension XCUIElement {
    func replaceNativeText(with value: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        tap()
        sleep(1) // Let the field finish scrolling above the keyboard.
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
