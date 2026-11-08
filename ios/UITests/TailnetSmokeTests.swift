import XCTest

/// Optional read-only attach to an explicitly selected existing session.
/// Supply TEST_RUNNER_AGENTBOARD_TEST_URL and TEST_RUNNER_AGENTBOARD_TEST_SESSION
/// to xcodebuild. Never types into the session or changes its metadata.
final class TailnetSmokeTests: XCTestCase {
    func testExistingSessionOverTailnet() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let url = env["AGENTBOARD_TEST_URL"], let name = env["AGENTBOARD_TEST_SESSION"] else {
            throw XCTSkip("Set the explicit tailnet server and session for this optional smoke test.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", url]
        app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 20))
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText(name)
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["Enter"])
        waitForExpectations(timeout: 20)
        XCTAssertTrue(app.webViews.firstMatch.staticTexts.firstMatch.waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }
}
