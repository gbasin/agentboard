import XCTest
import UIKit

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
    /// Real touch -> WKWebView -> native WebSocket -> tmux, with history far
    /// beyond any keyboard-resize overflow. No JS gesture or transport mocks.
    func testTerminalScrollbackReachesHistoryAndTypingReturnsToLive() {
        let app = launch(); open("native-live-one", app: app)
        let token = String(UUID().uuidString.prefix(8))
        type("for i in {1..240}; do printf 'ROW_%s_%03d\\n' \(token) $i; done", app: app)
        XCTAssertTrue(output("ROW_\(token)_240", in: app).waitForExistence(timeout: 10))
        let oldRows = app.webViews.firstMatch.staticTexts.containing(NSPredicate(
            format: "label MATCHES %@", ".*ROW_\(token)_(0[2-9][0-9]|1[0-2][0-9]).*"))
        XCTAssertFalse(oldRows.firstMatch.exists, "Old history must start offscreen")
        let terminal = app.webViews.firstMatch
        for _ in 0..<18 {
            terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.2))
                .press(forDuration: 0.05, thenDragTo: terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.8)))
            if oldRows.firstMatch.waitForExistence(timeout: 1) { break }
        }
        XCTAssertTrue(oldRows.firstMatch.exists, "Swipes must reach tmux history over 100 lines back")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        capture("tmux-history-keyboard-open")
        // Do not tap the terminal: that separately cancels copy mode and would
        // hide a bug when typing into a keyboard that was open while scrolling.
        app.typeText("printf 'RETURN_%s_OK\\n' \(token)")
        app.tapTerminalKey("Enter")
        XCTAssertTrue(output("RETURN_\(token)_OK", in: app).waitForExistence(timeout: 10))
        capture("tmux-history-returned-to-live")
    }

    /// Same distance and velocity, with/without an endpoint hold. This fails
    /// without momentum even though ordinary scrollback still works.
    func testFlickTravelsFurtherAndExitCopyModeStaysLive() throws {
        let app = launch(); open("native-live-one", app: app)
        let token = String(UUID().uuidString.prefix(8))
        type("for i in {1..400}; do printf 'FLICK_%s_%03d\\n' \(token) $i; done", app: app)
        XCTAssertTrue(output("FLICK_\(token)_400", in: app).waitForExistence(timeout: 10))
        let terminal = app.webViews.firstMatch
        func earliest() throws -> Int {
            let text = terminal.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "\n")
            let regex = try NSRegularExpression(pattern: "FLICK_\(token)_([0-9]{3})")
            let values = regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
                Int((text as NSString).substring(with: $0.range(at: 1)))
            }
            return try XCTUnwrap(values.min(), "Expected seeded rows in terminal: " + text)
        }
        func swipe(hold: TimeInterval) {
            terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.2))
                .press(forDuration: 0, thenDragTo: terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.8)),
                       withVelocity: XCUIGestureVelocity(rawValue: 1200), thenHoldForDuration: hold)
            Thread.sleep(forTimeInterval: 1.5)
        }
        swipe(hold: 0.25)
        let drag = try earliest()
        app.buttons["Session actions"].tap(); app.tapNativeMenuAction("Scroll to bottom")
        XCTAssertTrue(output("FLICK_\(token)_400", in: app).waitForExistence(timeout: 5))
        swipe(hold: 0)
        let flick = try earliest()
        XCTAssertLessThan(flick, drag - 10, "Flick must traverse more history than the same drag held still at release")
        let evidence = XCTAttachment(string: "Earliest visible row: held drag \(drag), flick \(flick); additional history \(drag - flick) lines")
        evidence.name = "flick-distance"; evidence.lifetime = .keepAlways; add(evidence)
        capture("flick-momentum-history")
        app.buttons["Session actions"].tap(); app.tapNativeMenuAction("Exit copy mode")
        XCTAssertTrue(output("FLICK_\(token)_400", in: app).waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertTrue(output("FLICK_\(token)_400", in: app).exists, "Exit copy mode must remain at live output")
        capture("flick-exit-stays-live")
    }

    func testFlickSelectionAndBackgroundReturnToUsableTerminal() {
        let app = launch(); open("native-live-one", app: app)
        let token = String(UUID().uuidString.prefix(8))
        type("for i in {1..240}; do printf 'PAUSE_%s_%03d\\n' \(token) $i; done", app: app)
        XCTAssertTrue(output("PAUSE_\(token)_240", in: app).waitForExistence(timeout: 10))
        let terminal = app.webViews.firstMatch
        func flick() {
            terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.2))
                .press(forDuration: 0, thenDragTo: terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.8)),
                       withVelocity: XCUIGestureVelocity(rawValue: 1200), thenHoldForDuration: 0)
        }
        flick()
        app.buttons["Session actions"].tap(); app.tapNativeMenuAction("Select text")
        let snapshot = app.textViews["terminal-snapshot-text"]
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10))
        let frozen = snapshot.value as? String
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(snapshot.value as? String, frozen)
        capture("flick-selection-frozen")
        app.buttons["Done"].tap()
        XCTAssertTrue(terminal.waitForExistence(timeout: 5))
        flick()
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        let returned = terminal.staticTexts.allElementsBoundByIndex.map(\.label).filter { $0.hasPrefix("PAUSE_\(token)_") }
        XCTAssertFalse(returned.isEmpty)
        // tmux's clock/header and xterm's live announcement are transient. A
        // middle history row must remain visible after the renderer settles.
        if !returned.isEmpty {
            let anchor = returned[returned.count / 2]
            Thread.sleep(forTimeInterval: 1.5)
            XCTAssertTrue(output(anchor, in: app).exists, "Reactivation must not resume the old flick")
        }
        type("printf 'AFTER_%s_OK\\n' \(token)", app: app)
        XCTAssertTrue(output("AFTER_\(token)_OK", in: app).waitForExistence(timeout: 10))
        capture("flick-background-restored")
    }

    func testNativeClipboardAfterFlickInsertsBeforeExplicitEnter() {
        let token = String(UUID().uuidString.prefix(8))
        UIPasteboard.general.string = "printf 'PASTED_%s_OK\\n' \(token)"
        defer { UIPasteboard.general.items = [] }
        let app = launch(); open("native-live-one", app: app)
        type("for i in {1..240}; do printf 'PASTE_HISTORY_%03d\\n' $i; done", app: app)
        XCTAssertTrue(output("PASTE_HISTORY_240", in: app).waitForExistence(timeout: 10))
        let terminal = app.webViews.firstMatch
        terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.2))
            .press(forDuration: 0, thenDragTo: terminal.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.8)),
                   withVelocity: XCUIGestureVelocity(rawValue: 1200), thenHoldForDuration: 0)
        app.tapTerminalKey("Paste text")
        app.buttons["Paste from clipboard"].tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        XCTAssertTrue(output("PASTED_%s_OK", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(output("PASTED_\(token)_OK", in: app).exists)
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertTrue(output("PASTED_%s_OK", in: app).exists, "Late wheel input must not hide the pasted command")
        capture("flick-clipboard-inserted-not-executed")
        app.tapTerminalKey("Enter")
        XCTAssertTrue(output("PASTED_\(token)_OK", in: app).waitForExistence(timeout: 10))
        capture("flick-clipboard-executed-on-enter")
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
