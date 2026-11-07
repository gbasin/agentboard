import XCTest

final class SpikeUITests: XCTestCase {
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
        app.buttons["Keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        capture("terminal-keyboard")
        app.buttons["Hide keyboard"].tap()
        app.buttons["Arrow keys"].tap()
        XCTAssertTrue(app.buttons["Up"].waitForExistence(timeout: 3))
        capture("terminal-arrows")
    }

    func testShellInputAndNativeEnter() {
        let app = XCUIApplication()
        app.launchArguments = ["-terminal", "-spikeEndpoint", "ws://127.0.0.1:4149"]
        app.launch()
        XCTAssertTrue(app.buttons["Keyboard"].waitForExistence(timeout: 10))
        sleep(2)
        app.buttons["Keyboard"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.typeText("printf 'NATIVE_%s_OK\\n' INPUT")
        app.buttons["Enter"].tap()
        sleep(2)
        capture("live-shell-keyboard")
        let text = app.webViews.firstMatch.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "NATIVE_INPUT_OK"))
        XCTAssertTrue(text.firstMatch.waitForExistence(timeout: 5))
        app.buttons["Hide keyboard"].tap()
        capture("live-shell")
    }
}
