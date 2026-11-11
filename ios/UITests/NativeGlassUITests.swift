import XCTest

/// Uses the loopback protocol fixture; verifies native navigation and bytes, not a live agent.
final class NativeGlassUITests: XCTestCase {
    private let base = "http://127.0.0.1:4192"
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() {
        if (testRun?.failureCount ?? 0) > 0 {
            capture("failure")
            let tree = XCTAttachment(string: XCUIApplication().debugDescription)
            tree.lifetime = .keepAlways; add(tree)
        }
        super.tearDown()
    }
    private func request(_ path: String, reset: Bool = false) -> [String: Any] {
        var request = URLRequest(url: URL(string: base + "/__fixture/" + path)!)
        if reset {
            request.httpMethod = "POST"
            request.httpBody = Data(#"{"scenario":"glass"}"#.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let done = expectation(description: path)
        var result: [String: Any] = [:]
        URLSession.shared.dataTask(with: request) { data, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            if let data { result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return result
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "native-glass-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func reveal(_ element: XCUIElement, app: XCUIApplication) {
        for _ in 0..<12 {
            let list = app.collectionViews.allElementsBoundByIndex.last ?? app.collectionViews.firstMatch
            let search = app.searchFields.firstMatch
            let toolbar = app.toolbars.firstMatch
            let top = (app.navigationBars.allElementsBoundByIndex.last ?? app.navigationBars.firstMatch).frame.maxY
            // Liquid Glass exposes a full-screen toolbar container. Its visible
            // buttons, not the container origin, bound the content viewport.
            let toolbarTop = toolbar.buttons.allElementsBoundByIndex.map(\.frame)
                .filter { $0.height > 0 && $0.minY > app.frame.midY }.map(\.minY).min()
            var bottom = min(list.frame.maxY, toolbarTop ?? app.frame.maxY)
            if search.exists && search.frame.midY > app.frame.midY { bottom = min(bottom, search.frame.minY) }
            if element.exists && element.isHittable && element.frame.maxY < bottom && element.frame.minY >= top { return }
            // Large accessibility rows can be taller than a swipe's travel.
            // Move toward the target without flinging past it in both directions.
            let upper = max(top, list.frame.minY) + 12
            let lower = min(bottom, list.frame.maxY) - 12
            guard lower > upper else { return }
            let middle = (upper + lower) / 2
            let limit = (lower - upper) * 0.4
            let distance = element.exists ? element.frame.midY - middle : limit
            let travel = min(limit, max(-limit, distance))
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(.init(dx: list.frame.midX, dy: middle))
            let end = origin.withOffset(.init(dx: list.frame.midX, dy: middle - travel))
            start.press(forDuration: 0, thenDragTo: end,
                        withVelocity: XCUIGestureVelocity(rawValue: 400), thenHoldForDuration: 0.2)
        }
    }
    func testCatalogMetadataAtCurrentTextSize() {
        _ = request("reset", reset: true)
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", base]
        app.launch()
        XCTAssertTrue(app.buttons["session-alpha-local"].waitForExistence(timeout: 15))
        let prs = app.buttons["pull-requests-alpha-local"]
        reveal(prs, app: app)
        XCTAssertTrue(prs.isHittable)
        XCTAssertTrue(app.buttons["activity-alpha-local"].isHittable)
        capture("sessions-metadata")
    }

    func testProjectChipsAcrossSessionsRecoverySavedAndHistory() {
        _ = request("reset", reset: true)
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", base]; app.launch()
        let row = app.buttons["session-alpha-local"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertTrue(row.staticTexts["project-chip-alpha"].exists)
        capture("project-chips-sessions")
        app.buttons["Library"].tap()
        XCTAssertTrue(app.navigationBars["Library"].waitForExistence(timeout: 5))
        let saved = app.buttons["saved-Recovered fixture"]
        reveal(saved, app: app)
        XCTAssertTrue(saved.staticTexts["project-chip-alpha"].exists)
        capture("project-chips-recovery")
        app.segmentedControls["library-category"].buttons["Saved"].tap()
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        XCTAssertTrue(saved.staticTexts["project-chip-alpha"].exists)
        capture("project-chips-saved")
        app.segmentedControls["library-category"].buttons["History"].tap()
        app.buttons["Conversation history (4)"].tap()
        XCTAssertTrue(app.staticTexts["project-chip-alpha"].firstMatch.waitForExistence(timeout: 5))
        capture("project-chips-history")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Hibernating conversations (4)"].tap()
        XCTAssertTrue(app.staticTexts["project-chip-alpha"].firstMatch.waitForExistence(timeout: 5))
        capture("project-chips-hibernating")
    }

    func testCatalogActivityMediaKeyboardAndRecovery() {
        _ = request("reset", reset: true)
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", base]
        app.launch()
        XCTAssertTrue(app.buttons["session-alpha-local"].waitForExistence(timeout: 15))
        capture("sessions")
        let activity = app.buttons["activity-alpha-local"]
        reveal(activity, app: app); activity.tap()
        XCTAssertTrue(app.navigationBars["Agent activity"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["UI reviewer"].exists)
        capture("activity")
        app.buttons["Done"].tap()
        let prs = app.buttons["pull-requests-alpha-local"]
        reveal(prs, app: app); prs.tap()
        XCTAssertTrue(app.buttons["agentboard #525"].waitForExistence(timeout: 5))
        capture("pull-requests")
        app.buttons["Done"].tap()
        let row = app.buttons["session-alpha-local"]
        if !row.isHittable { app.collectionViews.firstMatch.swipeDown() }
        row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        let output = app.webViews.firstMatch.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Deterministic capability fixture")).firstMatch
        XCTAssertTrue(output.waitForExistence(timeout: 10))
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.65)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        capture("terminal-keyboard")
        app.tapTerminalKey("Arrow keys")
        app.buttons["Shift"].tap()
        app.tapTerminalKey("Tab")
        app.tapTerminalKey("Arrow keys")
        app.buttons["Shift"].tap()
        app.tapTerminalKey("Enter")
        let received = request("input")["input"] as? [String] ?? []
        XCTAssertTrue(received.contains("\u{1b}[Z"), "Shift+Tab must reach the server")
        XCTAssertTrue(received.contains("\n"), "Shift+Enter must reach the server without CR")
        app.tapTerminalKey("Hide keyboard")
        app.buttons["available-media"].tap()
        XCTAssertTrue(app.navigationBars["Media and links"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Implementation notes"].exists)
        capture("media")
        app.buttons["Done"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Library"].tap()
        XCTAssertTrue(app.navigationBars["Library"].waitForExistence(timeout: 5))
        let saved = app.buttons["saved-Recovered fixture"]
        reveal(saved, app: app)
        XCTAssertTrue(saved.exists)
        capture("library")
    }
}
