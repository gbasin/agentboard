import XCTest
import UIKit
import UniformTypeIdentifiers

/// Optional Simulator acceptance against the explicitly seeded private backend.
final class ExternalAcceptanceUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["AGENTBOARD_EXTERNAL_ACCEPTANCE"] == "1" else {
            throw XCTSkip("Opt in after preparing the private acceptance fixtures.")
        }
        XCUIDevice.shared.orientation = .portrait
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
    /// Uses only the disposable Codex editor; never submits a prompt or presses Enter.
    func testImageAcceptedByRealCodexEditor() {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16))
        let png = renderer.pngData { context in UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 16, height: 16)) }
        UIPasteboard.general.items = [[UTType.png.identifier: png]]
        defer { UIPasteboard.general.items = [] }
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]; app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 20))
        let search = app.searchFields["Find a session"]; search.tap(); search.typeText("native-image-acceptance\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "native-image-acceptance")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        app.tapTerminalKey("Paste text"); app.buttons["Paste from clipboard"].tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        XCTAssertTrue(app.buttons["confirm-attachments"].waitForExistence(timeout: 15)); app.buttons["confirm-attachments"].tap()
        let accepted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.webViews.staticTexts.allElementsBoundByIndex.map(\.label).joined().contains("[Image #1]")
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [accepted], timeout: 20), .completed)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "real-codex-image-accepted"; shot.lifetime = .keepAlways; add(shot)
    }

    func testSlowMediaDiscoveryAndBackgroundRecovery() {
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]; app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 20)); app.buttons["Library"].tap()
        app.segmentedControls["library-category"].buttons["History"].tap()
        let history = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Conversation history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10)); reveal(history, app: app); history.tap()
        let search = app.searchFields["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10)); search.tap(); search.typeText("native-slow-media\n")
        reveal(app.buttons["Media and links"], app: app); app.buttons["Media and links"].tap()
        let firstPage = app.buttons["Page 1"]
        let initialReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: firstPage)
        XCTAssertEqual(XCTWaiter.wait(for: [initialReady], timeout: 30), .completed)
        let generated = expectation(description: "Append bounded real transcript")
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4194/append")!)
        request.httpMethod = "POST"; request.timeoutInterval = 60
        URLSession.shared.dataTask(with: request) { _, response, error in
            XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200); generated.fulfill()
        }.resume()
        wait(for: [generated], timeout: 65)
        firstPage.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        let refresh = app.buttons["Back to first page"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 10))
        refresh.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        let progress = app.activityIndicators["Discovering media…"]
        XCTAssertTrue(progress.waitForExistence(timeout: 20))
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = "slow-real-media-progress"; shot.lifetime = .keepAlways; add(shot)
        XCUIDevice.shared.press(.home); sleep(2); app.activate()
        let resume = app.buttons["Continue discovery"]
        if resume.waitForExistence(timeout: 5) { resume.tap() }
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !progress.exists && !app.activityIndicators["Loading media…"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 120), .completed)
        if app.buttons["refresh-changed-media"].exists { app.buttons["refresh-changed-media"].tap() }
        XCTAssertFalse(app.buttons["Retry discovery"].exists)
        XCTAssertFalse(app.buttons["Retry media"].exists)
        let completeCount = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.staticTexts.allElementsBoundByIndex.contains { $0.label.filter(\.isNumber) == "500001" }
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [completeCount], timeout: 20), .completed)
        let next = app.buttons["Next page"]
        let pageable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: next)
        XCTAssertEqual(XCTWaiter.wait(for: [pageable], timeout: 30), .completed)
        next.tap(); XCTAssertTrue(app.buttons["Page 2"].waitForExistence(timeout: 15))
        let done = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); done.name = "slow-real-media-recovered"; done.lifetime = .keepAlways; add(done)
    }

}
