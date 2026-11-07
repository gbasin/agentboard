import XCTest

// Keep the finger down between the hold and drag; separate Maestro gestures
// lift the finger and cannot exercise the TUI's mouse-selection path.
final class NativeGestureTests: XCTestCase {
    @MainActor
    func testClaudeOutputSelection() { select(agentTab: 0.07, marker: "CLAUDE_PASTE_alpha") }

    @MainActor
    func testCodexOutputSelection() { select(agentTab: 0.20, marker: "CODEX_PASTE_alpha") }

    @MainActor
    private func select(agentTab: CGFloat, marker: String) {
        let app = XCUIApplication(bundleIdentifier: "com.apple.webapp")
        app.activate()
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10))
        window.coordinate(withNormalizedOffset: CGVector(dx: agentTab, dy: 0.16)).tap()
        // Fixture output is above the prompt; avoid the left-edge drawer gesture.
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.28))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.44, dy: 0.28))
        start.press(forDuration: 0.6, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
        let copy = app.buttons["Copy selection"]
        let offered = copy.waitForExistence(timeout: 5)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = marker + "-selection"
        shot.lifetime = .keepAlways
        add(shot)
        XCTAssertTrue(offered, app.debugDescription)
        if offered { copy.tap() }
    }
}
