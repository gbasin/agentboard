import XCTest

/// Run against the isolated real backend on port 4151, seeded with two shells.
/// No commands are sent to the user's existing agent sessions.
final class LiveUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    func output(_ value: String, in app: XCUIApplication) -> XCUIElement {
        app.webViews.firstMatch.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }
    func capture(_ name: String) {
        sleep(1) // Let keyboard key animations settle before capturing evidence.
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]
        app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 15))
        return app
    }
    func open(_ name: String, app: XCUIApplication) {
        let search = app.searchFields["Find a session"]
        search.tap()
        if search.buttons["Clear text"].exists { search.buttons["Clear text"].tap() }
        XCTAssertTrue((search.value as? String ?? "") == "" || (search.value as? String) == search.placeholderValue)
        search.typeText(name + "\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Enter"].waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "enabled == true")
        expectation(for: ready, evaluatedWith: app.buttons["Enter"])
        waitForExpectations(timeout: 15)
    }
    func type(_ command: String, app: XCUIApplication) {
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.65)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.typeText(command)
        app.tapTerminalKey("Enter")
    }
    func testLiveShellPasteAndBackgroundRecovery() {
        let app = launch()
        let token = String(UUID().uuidString.prefix(8))
        capture("live-catalog")
        open("native-live-one", app: app)
        type("printf 'SWIFT_%s_OK\\n' \(token)", app: app)
        XCTAssertTrue(output("SWIFT_\(token)_OK", in: app).waitForExistence(timeout: 5))
        capture("live-terminal-keyboard")
        app.tapTerminalKey("Paste text")
        let editor = app.textViews["Text to paste"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap(); editor.typeText("printf 'LIVE_%s_OK\\n' \(token)")
        app.buttons["Insert"].tap()
        XCTAssertTrue(app.buttons["Hide keyboard"].waitForExistence(timeout: 5))
        XCTAssertFalse(output("LIVE_\(token)_OK", in: app).exists)
        app.tapTerminalKey("Enter")
        XCTAssertTrue(output("LIVE_\(token)_OK", in: app).waitForExistence(timeout: 5))
        app.tapTerminalKey("Hide keyboard")
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["Enter"])
        waitForExpectations(timeout: 15)
        XCTAssertTrue(output("SWIFT_\(token)_OK", in: app).waitForExistence(timeout: 5))
        type("printf 'RESUME_%s_OK\\n' \(token)", app: app)
        XCTAssertTrue(output("RESUME_\(token)_OK", in: app).waitForExistence(timeout: 5))
        app.tapTerminalKey("Hide keyboard")
        capture("live-resumed")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        open("native-live-two", app: app)
        XCTAssertFalse(output("SWIFT_\(token)_OK", in: app).exists)
        type("printf 'SECOND_%s_OK\\n' \(token)", app: app)
        XCTAssertTrue(output("SECOND_\(token)_OK", in: app).waitForExistence(timeout: 5))
        capture("live-second-session")
    }
    func testConnectionAddressValidation() {
        let app = launch()
        app.buttons["connection-status"].tap()
        let address = app.textFields["server-address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.press(forDuration: 1)
        if app.menuItems["Select All"].exists { app.menuItems["Select All"].tap() }
        // Use the current value's length, avoiding dependence on a selection menu.
        address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (address.value as? String ?? "").count))
        address.typeText("not-a-server")
        XCTAssertFalse(app.buttons["Connect"].isEnabled)
        capture("live-invalid-address")
    }
    func testMultilinePasteWaitsForExplicitEnter() {
        let app = launch(); open("native-live-two", app: app)
        let token = String(UUID().uuidString.prefix(8))
        app.tapTerminalKey("Paste text")
        let editor = app.textViews["Text to paste"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap()
        editor.typeText("printf 'MULTI_A_%s_OK\\n' \(token)\nprintf 'MULTI_B_%s_OK\\n' \(token)")
        app.buttons["Insert"].tap()
        XCTAssertFalse(output("MULTI_A_\(token)_OK", in: app).exists)
        XCTAssertFalse(output("MULTI_B_\(token)_OK", in: app).exists)
        app.tapTerminalKey("Enter")
        XCTAssertTrue(output("MULTI_A_\(token)_OK", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(output("MULTI_B_\(token)_OK", in: app).waitForExistence(timeout: 5))
        capture("live-multiline-paste")
    }

    func testFrozenSnapshotRefreshCopyAndReturnToInput() {
        let app = launch()
        open("native-live-one", app: app)
        let token = "SNAPSHOT_" + String(UUID().uuidString.prefix(8))
        type("printf '%s\\n' " + token, app: app)
        XCTAssertTrue(output(token, in: app).waitForExistence(timeout: 5))
        app.buttons["Session actions"].tap()
        app.tapNativeMenuAction("Select text")
        let snapshot = app.textViews["terminal-snapshot-text"]
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10))
        XCTAssertTrue((snapshot.value as? String ?? "").contains(token))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("frozen-terminal-selection")
        snapshot.coordinate(withNormalizedOffset: .init(dx: 0.18, dy: 0.96)).press(forDuration: 1)
        capture("frozen-terminal-selection-active")
        app.buttons["Refresh"].tap()
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10))
        app.buttons["Copy all"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 5))
        type("printf 'AFTER_%s\\n' " + token, app: app)
        XCTAssertTrue(output("AFTER_" + token, in: app).waitForExistence(timeout: 5))
    }

    func testSessionOverviewSwitchesWithStatus() {
        let app = launch()
        open("native-live-one", app: app)
        let overview = app.buttons["session-overview"]
        XCTAssertTrue(overview.waitForExistence(timeout: 5))
        XCTAssertFalse((overview.value as? String ?? "").isEmpty)
        capture("terminal-session-overview")
        overview.tap()
        let other = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "native-live-two ·")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.tap()
        XCTAssertTrue(app.buttons["Switch session, native-live-two"].waitForExistence(timeout: 10))
    }

}
