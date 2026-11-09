import XCTest

/// Actual backend on 4151; 4193 changes only reserved private transcript fixtures.
final class MediaActivityUITests: XCTestCase {
    private let provider = "22222222-3333-4444-8555-666666666666"
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() {
        if (testRun?.failureCount ?? 0) > 0 {
            capture("failure")
            let tree = XCTAttachment(string: XCUIApplication().debugDescription); tree.lifetime = .keepAlways; add(tree)
        }
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "media-activity-" + name; shot.lifetime = .keepAlways; add(shot)
    }
    private func request(_ url: String, post: Bool = false) -> Any? {
        let done = expectation(description: url)
        var result: Any?
        var request = URLRequest(url: URL(string: url)!)
        if post { request.httpMethod = "POST" }
        URLSession.shared.dataTask(with: request) { data, response, error in
            XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            if let data { result = try? JSONSerialization.jsonObject(with: data) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }
    private func reveal(_ element: XCUIElement, app: XCUIApplication) {
        for _ in 0..<30 {
            let top = app.navigationBars.allElementsBoundByIndex.last?.frame.maxY ?? app.frame.minY
            var bottom = app.frame.maxY - 50
            if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY) }
            if app.searchFields.firstMatch.exists && app.searchFields.firstMatch.frame.midY > app.frame.midY {
                bottom = min(bottom, app.searchFields.firstMatch.frame.minY - 60)
            }
            if element.exists && element.isHittable && element.frame.minY >= top && element.frame.maxY < bottom { return }
            (app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? app.collectionViews.firstMatch).swipeUp(velocity: .slow)
        }
    }
    private func fixtureCatalog() -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]; app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 15))
        let search = app.searchFields["Find a session"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("native-media-activity\n")
        return app
    }
    func testRealActivityUpdatesWhileSheetRemainsOpen() throws {
        _ = request("http://127.0.0.1:4193/activity/running", post: true)
        let sessions = try XCTUnwrap(request("http://127.0.0.1:4151/api/sessions") as? [[String: Any]])
        let id = try XCTUnwrap(sessions.first { $0["agentSessionId"] as? String == provider }?["id"] as? String)
        let app = fixtureCatalog()
        let activity = app.buttons["activity-" + id]
        reveal(activity, app: app); XCTAssertTrue(activity.waitForExistence(timeout: 15)); activity.tap()
        XCTAssertTrue(app.staticTexts["Native activity reviewer"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Tool pending: Read"].waitForExistence(timeout: 10))
        capture("running")
        reveal(app.staticTexts["Tool pending: Read"], app: app); capture("running-detail")
        _ = request("http://127.0.0.1:4193/activity/done", post: true)
        let count = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "0 running")).firstMatch
        XCTAssertTrue(count.waitForExistence(timeout: 20))
        reveal(app.staticTexts["Turn finished"], app: app); capture("completed")
    }
    func testRealMediaSearchPagingAndImageNeighbors() throws {
        let sessions = try XCTUnwrap(request("http://127.0.0.1:4151/api/sessions") as? [[String: Any]])
        let id = try XCTUnwrap(sessions.first { $0["agentSessionId"] as? String == provider }?["id"] as? String)
        let app = fixtureCatalog()
        let row = app.buttons["session-" + id]
        XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        let media = app.buttons["available-media"]
        XCTAssertTrue(media.waitForExistence(timeout: 15)); media.tap()
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "media-item-")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        capture("catalog")
        first.tap()
        XCTAssertTrue(app.images["Session image"].waitForExistence(timeout: 10))
        let next = app.buttons["Next"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: next)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
        next.tap(); XCTAssertTrue(app.buttons["Previous"].isEnabled)
        capture("image-neighbor")
        let preview = app.navigationBars["Media"]
        preview.buttons["Done"].tap()
        // The preview retains a live accessibility tree during dismissal. Its
        // underlying catalog can exist while the modal still blocks paging.
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: preview)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 15), .completed)
        let nextPage = app.buttons["Next page"]
        XCTAssertTrue(nextPage.isHittable); XCTAssertTrue(nextPage.isEnabled); nextPage.tap()
        XCTAssertTrue(app.buttons["Page 2"].waitForExistence(timeout: 10))
        capture("second-page")
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.exists); search.tap(); search.typeText("native-042")
        let match = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Catalog reference 042")).firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 15))
        search.typeText("\n")
        reveal(match, app: app)
        XCTAssertTrue(match.isHittable)
        capture("search")
    }
}
