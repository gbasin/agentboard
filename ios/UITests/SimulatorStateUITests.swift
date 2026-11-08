import XCTest

/// Run in dark appearance and accessibility text sizes via simctl ui.
final class SimulatorStateUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait }

    private func launch(server: String) -> XCUIApplication {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", server]
        app.launch()
        return app
    }
    private func capture(_ name: String) {
        sleep(1)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func assertVisible(_ element: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(element.isHittable, app.debugDescription)
        let screen = app.windows.firstMatch.frame
        XCTAssertGreaterThanOrEqual(element.frame.minX, screen.minX)
        XCTAssertLessThanOrEqual(element.frame.maxX, screen.maxX)
        XCTAssertGreaterThanOrEqual(element.frame.minY, screen.minY)
        XCTAssertLessThanOrEqual(element.frame.maxY, screen.maxY)
    }
    func testFirstRunAndConnectionSheet() {
        let app = launch(server: "")
        XCTAssertTrue(app.buttons["Set server address"].waitForExistence(timeout: 10))
        // Large accessibility text makes this section scroll; the navigation
        // connection action must stay reachable without finding its footer.
        assertVisible(app.buttons["connection-status"], in: app)
        capture("sim-setup")
        app.buttons["connection-status"].tap()
        let address = app.textFields["server-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap(); address.typeText("http://example.test:4040")
        XCTAssertTrue(app.buttons["Connect"].isEnabled)
        assertVisible(app.buttons["Connect"], in: app)
        capture("sim-connection")
        app.buttons["Cancel"].tap()
    }
    func testUnavailableServerCanBeChanged() {
        let app = launch(server: "http://127.0.0.1:49999")
        XCTAssertTrue(app.staticTexts["Server unavailable"].waitForExistence(timeout: 10))
        assertVisible(app.buttons["connection-status"], in: app)
        assertVisible(app.buttons["Retry"], in: app)
        capture("sim-offline")
        app.buttons["connection-status"].tap()
        XCTAssertTrue(app.textFields["server-address"].waitForExistence(timeout: 5))
    }
    func testLiveTerminalRotatesWithKeyboard() {
        let app = launch(server: "http://127.0.0.1:4151")
        XCTAssertTrue(app.waitForBoardConnection(timeout: 15))
        capture("sim-catalog")
        let search = app.searchFields["Find a session"]
        search.tap(); search.typeText("native-live-one\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "native-live-one")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        let enter = app.buttons["Enter"]
        XCTAssertTrue(enter.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: enter)
        waitForExpectations(timeout: 15)
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.65)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        for name in ["Enter", "Escape", "Tab", "Arrow keys", "Control", "Paste text", "Hide keyboard"] {
            assertVisible(app.buttons[name], in: app)
            XCTAssertLessThanOrEqual(app.buttons[name].frame.height, 60)
        }
        capture("sim-terminal-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(1)
        for name in ["Enter", "Escape", "Tab", "Arrow keys", "Control", "Paste text", "Hide keyboard"] {
            assertVisible(app.buttons[name], in: app)
        }
        XCTAssertGreaterThan(app.webViews.firstMatch.frame.height, 30)
        let token = String(UUID().uuidString.prefix(8))
        app.typeText("printf 'ROTATE_%s_OK\\n' \(token)")
        enter.tap()
        let output = app.webViews.firstMatch.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "ROTATE_\(token)_OK")).firstMatch
        XCTAssertTrue(output.waitForExistence(timeout: 5))
        capture("sim-terminal-landscape")
        app.buttons["Hide keyboard"].tap()
        capture("sim-terminal-landscape-reading")
    }
}
