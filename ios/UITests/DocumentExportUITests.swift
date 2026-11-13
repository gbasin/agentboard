import XCTest

/// Exports a real PDF to seeded Files storage; CI verifies its bytes after the UI run.
final class DocumentExportUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() {
        if (testRun?.failureCount ?? 0) > 0 {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "document-export-failure"; screenshot.lifetime = .keepAlways; add(screenshot)
            let hierarchy = XCTAttachment(string: XCUIApplication().debugDescription)
            hierarchy.name = "document-export-hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
        }
        super.tearDown()
    }
    private func reveal(_ element: XCUIElement, app: XCUIApplication) {
        for _ in 0..<20 {
            let top = app.navigationBars.allElementsBoundByIndex.last?.frame.maxY ?? app.frame.minY
            var bottom = app.frame.maxY - 50
            if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY) }
            if let search = app.searchFields.allElementsBoundByIndex.last, search.frame.midY > app.frame.midY { bottom = min(bottom, search.frame.minY) }
            if element.exists && element.isHittable && element.frame.minY >= top && element.frame.maxY < bottom { return }
            let list = app.collectionViews.allElementsBoundByIndex.last ?? app.collectionViews.firstMatch
            list.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(element.exists); XCTAssertTrue(element.isHittable)
    }
    func testDocumentShareToFiles() {
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]; app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 20)); app.buttons["Library"].tap()
        app.segmentedControls["library-category"].buttons["History"].tap()
        let history = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Conversation history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10)); reveal(history, app: app); history.tap()
        let search = app.searchFields["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10)); search.tap(); search.typeText("parity-saved-transcript\n")
        reveal(app.buttons["Media and links"], app: app); app.buttons["Media and links"].tap()
        let pdf = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "application/pdf")).firstMatch
        for _ in 0..<8 where !pdf.exists || !pdf.isHittable { app.collectionViews.firstMatch.swipeUp() }
        XCTAssertTrue(pdf.waitForExistence(timeout: 10)); pdf.tap()
        XCTAssertTrue(app.buttons["Share document"].waitForExistence(timeout: 20)); app.buttons["Share document"].tap()
        let save = app.cells["Save to Files"]
        let more = app.cells["View More"]
        let actions = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in save.exists || more.exists }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [actions], timeout: 20), .completed)
        if !save.exists { more.tap() }
        XCTAssertTrue(save.waitForExistence(timeout: 10)); save.tap()
        let folder = app.cells.containing(NSPredicate(format: "label BEGINSWITH %@", "Agentboard E2E Exports")).firstMatch
        XCTAssertTrue(app.textFields["DOCPicker.filenameTextField"].waitForExistence(timeout: 20))
        // Navigate explicitly; never treat a failed folder tap as a valid destination.
        let destination = app.navigationBars.buttons["Agentboard E2E Exports, Actions Menu"].firstMatch
        if !destination.exists {
            if !folder.waitForExistence(timeout: 3) {
                let back = app.navigationBars.buttons["BackButton"].firstMatch
                if back.exists { back.tap() }
                let local = app.staticTexts["On My iPhone"]
                if local.waitForExistence(timeout: 3) { local.tap() }
            }
            XCTAssertTrue(folder.waitForExistence(timeout: 10)); folder.tap()
        }
        XCTAssertTrue(destination.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 10)); app.buttons["Save"].tap()
        if app.buttons["Replace"].waitForExistence(timeout: 2) { app.buttons["Replace"].tap() }
        let saved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.textFields["DOCPicker.filenameTextField"])
        XCTAssertEqual(XCTWaiter.wait(for: [saved], timeout: 20), .completed)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "document-shared-to-files"; shot.lifetime = .keepAlways; add(shot)
    }
}
