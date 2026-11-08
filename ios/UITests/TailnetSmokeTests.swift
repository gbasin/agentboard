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
    /// Optional live GitHub read through an explicitly chosen backend; never opens a terminal.
    func testLivePullRequestChecksOverTailnet() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let url = env["AGENTBOARD_TEST_URL"], let name = env["AGENTBOARD_TEST_SESSION"],
              let sessionID = env["AGENTBOARD_TEST_SESSION_ID"], let number = env["AGENTBOARD_TEST_PR_NUMBER"],
              let title = env["AGENTBOARD_TEST_PR_TITLE"], let check = env["AGENTBOARD_TEST_PR_CHECK"] else {
            throw XCTSkip("Set an explicit backend, catalog session and live pull request for this read-only check.")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", url]; app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 20))
        let search = app.searchFields["Find a session"]
        search.tap(); search.typeText(name + "\n")
        let requests = app.buttons["pull-requests-" + sessionID]
        XCTAssertTrue(requests.waitForExistence(timeout: 15)); requests.tap()
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "#" + number)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts[check].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Pull request details are unavailable. Check GitHub access on the server."].exists)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "live-github-checks"; shot.lifetime = .keepAlways; add(shot)
    }

}
