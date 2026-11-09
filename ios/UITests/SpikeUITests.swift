import XCTest

final class SpikeUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    func openKeyboard(_ app: XCUIApplication) {
        app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65)).tap()
    }

    func output(_ value: String, in app: XCUIApplication) -> XCUIElement {
        app.webViews.firstMatch.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }

    func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSampleNavigationAndKeyboard() {
        let app = XCUIApplication()
        app.launchArguments = ["-spikeEndpoint", ""]
        app.launch()
        XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 10))
        capture("sessions-light")
        app.buttons["session-pure-pod-2"].tap()
        XCTAssertTrue(app.buttons["Session actions"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 5))
        sleep(2)
        capture("terminal-light")
        openKeyboard(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Keyboard"].exists)
        XCTAssertTrue(app.revealTerminalKey("Tab").exists)
        XCTAssertTrue(app.revealTerminalKey("Hide keyboard").exists)
        XCTAssertFalse(app.buttons["Next"].exists)
        XCTAssertFalse(app.buttons["Previous"].exists)
        capture("terminal-keyboard")
        app.tapTerminalKey("Hide keyboard")
        app.tapTerminalKey("Arrow keys")
        XCTAssertTrue(app.buttons["Up"].waitForExistence(timeout: 3))
        capture("terminal-arrows")
    }

    func testShellInputAndNativeEnter() {
        let app = XCUIApplication()
        app.launchArguments = ["-terminal", "-spikeEndpoint", "ws://127.0.0.1:4149"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        openKeyboard(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.typeText("printf 'NATIVE_%s_OK\\n' INPUT")
        app.tapTerminalKey("Enter")
        sleep(2)
        capture("live-shell-keyboard")
        let text = app.webViews.firstMatch.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "NATIVE_INPUT_OK"))
        XCTAssertTrue(text.firstMatch.waitForExistence(timeout: 5))
        app.tapTerminalKey("Hide keyboard")
        capture("live-shell")
    }

    func testNativeControlBytes() {
        let app = XCUIApplication()
        app.launchArguments = ["-terminal", "-spikeEndpoint", "ws://127.0.0.1:4149"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        openKeyboard(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let command = "python3 -u -c \"import sys,tty,termios; old=termios.tcgetattr(0); tty.setraw(0); print('RAW_'+'READY',flush=True); data=sys.stdin.buffer.read(10); termios.tcsetattr(0,termios.TCSADRAIN,old); print('KEY_'+'BYTES:'+data.hex())\""
        app.typeText(command)
        app.tapTerminalKey("Enter")
        XCTAssertTrue(output("RAW_READY", in: app).waitForExistence(timeout: 8))
        app.tapTerminalKey("Control")
        app.typeText("c")
        app.tapTerminalKey("Tab")
        app.tapTerminalKey("Escape")
        app.tapTerminalKey("Arrow keys")
        app.buttons["Up"].tap()
        app.webViews.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        app.typeText(XCUIKeyboardKey.delete.rawValue)
        app.tapTerminalKey("Enter")
        app.typeText("é")
        XCTAssertTrue(output("KEY_BYTES:03091b1b5b417f0dc3a9", in: app).waitForExistence(timeout: 8))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        capture("native-control-bytes")
    }

    func testPasteWaitsForEnterAndRestoresKeyboard() {
        let app = XCUIApplication()
        app.launchArguments = ["-terminal", "-spikeEndpoint", "ws://127.0.0.1:4149"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        openKeyboard(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.tapTerminalKey("Paste text")
        let editor = app.textViews["Text to paste"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText("printf 'PASTE_%s_OK\\n' SAFE")
        app.buttons["Insert"].tap()
        XCTAssertTrue(app.buttons["Hide keyboard"].waitForExistence(timeout: 5))
        XCTAssertFalse(output("PASTE_SAFE_OK", in: app).exists)
        app.tapTerminalKey("Enter")
        XCTAssertTrue(output("PASTE_SAFE_OK", in: app).waitForExistence(timeout: 5))
        capture("native-paste")
    }
    func testScrollAndKeyboardTransitions() {
        let app = XCUIApplication()
        app.launchArguments = ["-terminal", "-spikeEndpoint", ""]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        openKeyboard(app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.webViews.firstMatch.swipeDown()
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        capture("terminal-scroll-keyboard")
        for _ in 0..<2 {
            app.tapTerminalKey("Hide keyboard")
            XCTAssertTrue(app.revealTerminalKey("Tab").exists)
            XCTAssertFalse(app.buttons["Hide keyboard"].exists)
            openKeyboard(app)
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        }
        capture("terminal-keyboard-repeat")
    }

}
