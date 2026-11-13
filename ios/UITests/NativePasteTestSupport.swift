import XCTest

extension XCUIApplication {
    /// Stabilize the sheet before keyboard presentation can move the Insert toolbar.
    func expandedPasteEditor(file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let editor = textViews["Text to paste"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5), file: file, line: line)
        let grabber = buttons["Sheet Grabber"]
        if grabber.value as? String != "Expanded" { grabber.swipeUp() }
        let expanded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Expanded"), object: grabber)
        XCTAssertEqual(XCTWaiter.wait(for: [expanded], timeout: 5), .completed, file: file, line: line)
        return editor
    }

    func insertPasteDraft(file: StaticString = #filePath, line: UInt = #line) {
        let sheet = navigationBars["Paste into terminal"]
        sheet.buttons["Insert"].tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10), file: file, line: line)
    }
}
