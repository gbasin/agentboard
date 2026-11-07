import XCTest

/// UI contract tests against the loopback-only scripted fixture on port 4192.
/// These prove native behavior under server capabilities, not a successful SSH connection.
final class ParityGapUITests: XCTestCase {
    private let base = "http://127.0.0.1:4192"
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() {
        if (testRun?.failureCount ?? 0) > 0 {
            capture("failure-" + name)
            let tree = XCTAttachment(string: XCUIApplication().debugDescription)
            tree.name = "gap-failure-accessibility"; tree.lifetime = .keepAlways; add(tree)
        }
        super.tearDown()
    }
    private func fixture(_ path: String, body: [String: Any] = [:]) {
        var request = URLRequest(url: URL(string: base + "/__fixture/" + path)!)
        request.httpMethod = "POST"
        request.httpBody = try! JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let finished = expectation(description: "Fixture " + path)
        URLSession.shared.dataTask(with: request) { _, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            finished.fulfill()
        }.resume()
        wait(for: [finished], timeout: 10)
    }
    private func launch(_ scenario: String) -> XCUIApplication {
        fixture("reset", body: ["scenario": scenario])
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", base]
        app.launch()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 10))
        return app
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "gap-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<12 {
            if element.exists && element.isHittable { return }
            let scroller = app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable })
                ?? app.tables.allElementsBoundByIndex.last(where: { $0.isHittable })
                ?? app.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable })
            guard let scroller else { XCTFail("No visible scroll container: " + app.debugDescription); return }
            scroller.swipeUp()
        }
        XCTAssertTrue(element.exists && element.isHittable, "Expected reachable UI element: \(element)\n" + app.debugDescription)
    }
    private func tap(_ title: String, in app: XCUIApplication) {
        let element = app.buttons[title]; reveal(element, in: app); element.tap()
    }
    private func select(_ id: String, in app: XCUIApplication) {
        let toggle = app.switches[id]; reveal(toggle, in: app)
        toggle.coordinate(withNormalizedOffset: .init(dx: 0.9, dy: 0.5)).tap()
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: toggle)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 5), .completed)
    }
    private func open(_ name: String, in app: XCUIApplication) {
        let search = app.searchFields["Find a session"]
        search.tap(); search.typeText(name + "\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        reveal(row, in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
    }

    private func readSharedSettings() -> [String: Any] {
        let finished = expectation(description: "Read persisted shared settings")
        var settings: [String: Any] = [:]
        URLSession.shared.dataTask(with: URL(string: base + "/api/settings/synced")!) { data, response, error in
            XCTAssertNil(error)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            if let data, let decoded = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                settings = decoded["settings"] as? [String: Any] ?? [:]
            }
            finished.fulfill()
        }.resume()
        wait(for: [finished], timeout: 10)
        return settings
    }

    func testManualReorderUsesNativeDragAndPersistsAfterRelaunch() {
        let app = launch("reorder")
        let first = app.buttons["session-alpha-local"]
        let second = app.buttons["session-alpha-remote"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        reveal(second, in: app)
        XCTAssertLessThan(first.frame.midY, second.frame.midY)
        app.buttons["Edit"].tap()
        let handles = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Reorder"))
        let destination = handles.element(boundBy: 0)
        let source = handles.element(boundBy: 1)
        reveal(source, in: app)
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        XCTAssertTrue(destination.isHittable, "Both reorder handles must be reachable for this drag: " + app.debugDescription)
        source.press(forDuration: 1, thenDragTo: destination)
        app.buttons["Done"].tap()
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            second.exists && first.exists && second.frame.midY < first.frame.midY
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 5), .completed)
        capture("manual-reordered")
        let persisted = readSharedSettings()
        XCTAssertEqual(persisted["sessionSortMode"] as? String, "manual")
        XCTAssertEqual(persisted["manualSessionOrder"] as? [String], ["alpha-remote-agent", "alpha-local-agent"])
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 10))
        XCTAssertTrue(second.waitForExistence(timeout: 5))
        reveal(first, in: app)
        XCTAssertLessThan(second.frame.midY, first.frame.midY)
        capture("manual-order-restored")
    }

    func testProjectAndHostSelectionsApplyToCatalogAndBothHistoryLists() {
        let app = launch("filters")
        app.buttons["Filter and sort"].tap()
        select("filter-projectFilters-/work/alpha", in: app)
        select("filter-hostFilters-remote", in: app)
        capture("selected-filters")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["session-alpha-remote"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["session-alpha-local"].exists)
        XCTAssertFalse(app.buttons["session-beta-approval"].exists)
        XCTAssertEqual(app.buttons["Filter and sort"].value as? String, "2 active filters")
        app.buttons["Library"].tap()
        tap("Conversation history (1)", in: app)
        reveal(app.buttons["History Alpha remote"], in: app)
        XCTAssertTrue(app.buttons["History Alpha remote"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["History Alpha local"].exists)
        XCTAssertFalse(app.buttons["History Beta"].exists)
        capture("filtered-history")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        tap("Hibernating conversations (1)", in: app)
        reveal(app.buttons["Sleeping Alpha remote"], in: app)
        XCTAssertTrue(app.buttons["Sleeping Alpha remote"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Sleeping Alpha local"].exists)
        XCTAssertFalse(app.buttons["Sleeping Beta"].exists)
        capture("filtered-hibernating")
    }

    func testHiddenApprovalNoticeRestoresFilteredSession() {
        let app = launch("hidden")
        let notice = app.buttons["hidden-permission-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["session-beta-approval"].exists)
        capture("hidden-approval")
        notice.tap()
        reveal(app.buttons["session-beta-approval"], in: app)
        XCTAssertTrue(app.buttons["session-beta-approval"].waitForExistence(timeout: 5))
        XCTAssertFalse(notice.exists)
        XCTAssertEqual(app.buttons["Filter and sort"].value as? String, "No active filters")
        capture("approval-restored")
    }

    func testRemoteManagementTracksServerCapabilityAndSessionOwnership() {
        let app = launch("remote")
        open("Alpha remote", in: app)
        app.buttons["Session actions"].tap()
        XCTAssertFalse(app.buttons["Rename session"].exists)
        XCTAssertFalse(app.buttons["Duplicate session"].exists)
        XCTAssertFalse(app.buttons["End session"].exists)
        XCTAssertFalse(app.buttons["Hibernate session"].exists)
        capture("remote-control-disabled")
        // At maximum text size the open native menu covers its toolbar anchor.
        // Dismiss through the visible terminal area below the menu.
        app.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.75)).tap()
        fixture("control", body: ["allowed": true])
        app.buttons["Session actions"].tap()
        reveal(app.buttons["Rename session"], in: app)
        XCTAssertTrue(app.buttons["Rename session"].exists)
        XCTAssertTrue(app.buttons["Duplicate session"].exists)
        capture("remote-control-enabled")
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 10))
        open("External remote", in: app)
        app.buttons["Session actions"].tap()
        XCTAssertFalse(app.buttons["Rename session"].exists)
        XCTAssertFalse(app.buttons["Duplicate session"].exists)
        XCTAssertFalse(app.buttons["End session"].exists)
        capture("remote-unmanaged")
    }

    func testRecoveryNoticeOpensRecoveryAndNewInterruptionsReappear() {
        let app = launch("recovery")
        let notice = app.buttons["recovery-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10)); capture("recovery-notice")
        notice.tap()
        XCTAssertTrue(app.navigationBars["Library"].waitForExistence(timeout: 5))
        capture("recovery-library")
        let state = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "State, ")).firstMatch
        XCTAssertTrue(state.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(state.label, "State, Recovery", state.debugDescription)
        reveal(app.buttons["saved-Recovered fixture"], in: app)
        XCTAssertTrue(app.buttons["saved-Recovered fixture"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        tap("Dismiss recovery notice", in: app)
        XCTAssertFalse(notice.exists)
        fixture("interrupt")
        XCTAssertTrue(notice.waitForExistence(timeout: 10))
        XCTAssertTrue(notice.label.contains("1 interrupted session"))
        capture("new-interruption")
    }
}
