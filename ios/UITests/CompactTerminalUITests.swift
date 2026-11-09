import XCTest

/// Verifies the scrolling strip against an isolated protocol fixture, including drag cancellation.
final class CompactTerminalUITests: XCTestCase {
    private let base = ProcessInfo.processInfo.environment["IOS_MENU_FIXTURE_URL"] ?? "http://127.0.0.1:4192"
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait; super.tearDown() }
    private func request(_ path: String, reset: Bool = false) -> [String: Any] {
        var request = URLRequest(url: URL(string: base + "/__fixture/" + path)!)
        if reset {
            request.httpMethod = "POST"; request.httpBody = Data(#"{"scenario":"glass"}"#.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let done = expectation(description: path)
        var result: [String: Any] = [:]
        URLSession.shared.dataTask(with: request) { data, response, error in
            XCTAssertNil(error); XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            if let data { result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10); return result
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "compact-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func openAlpha() -> XCUIApplication {
        _ = request("reset", reset: true)
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", base]; app.launch()
        XCTAssertTrue(app.buttons["session-alpha-local"].waitForExistence(timeout: 15))
        app.buttons["session-alpha-local"].tap()
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        return app
    }
    func testProjectContextFollowsSessionSwitch() {
        let app = openAlpha()
        let alpha = app.buttons["Switch session, Alpha local"]
        XCTAssertTrue(alpha.waitForExistence(timeout: 5))
        capture("project-alpha")
        XCTAssertEqual(alpha.value as? String, "/work/alpha, Working")
        alpha.tap()
        app.buttons["Beta approval"].tap()
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        let beta = app.buttons["Switch session, Beta approval"]
        XCTAssertTrue(beta.waitForExistence(timeout: 5))
        XCTAssertEqual(beta.value as? String, "/work/beta, Permission")
        capture("project-beta")
    }
    func testPasteAutocorrectAndExplicitInsert() {
        let app = openAlpha()
        app.tapTerminalKey("Paste text")
        let editor = app.textViews["Text to paste"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Insert"].isEnabled)
        editor.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        // Tap software keys: typeText does not exercise the keyboard's correction pipeline.
        for letter in "recieve" {
            app.keyboards.keys.matching(NSPredicate(format: "label ==[c] %@", String(letter))).firstMatch.tap()
        }
        app.keyboards.keys["space"].tap()
        // Capitalization follows the Simulator's global keyboard preference.
        let corrected = NSPredicate(format: "value ==[c] %@", "receive ")
        let correction = XCTNSPredicateExpectation(predicate: corrected, object: editor)
        let result = XCTWaiter.wait(for: [correction], timeout: 5)
        capture("paste-autocorrect")
        XCTAssertEqual(result, .completed, "The system keyboard should correct recieve to receive")
        let correctedText = editor.value as? String ?? ""
        XCTAssertEqual(request("input")["input"] as? [String], [], "Editing must not send terminal input")
        XCTAssertEqual(request("input")["pastes"] as? [String], [], "Editing must not paste the draft")
        app.buttons["Cancel"].tap()
        XCTAssertEqual(request("input")["input"] as? [String], [], "Cancel must not insert the draft")
        XCTAssertEqual(request("input")["pastes"] as? [String], [], "Cancel must not paste the draft")
        app.tapTerminalKey("Paste text")
        XCTAssertEqual(editor.value as? String, correctedText, "Cancel preserves the draft")
        app.buttons["Insert"].tap()
        XCTAssertTrue(app.buttons["Session actions"].waitForExistence(timeout: 5))
        XCTAssertEqual(request("input")["pastes"] as? [String], [correctedText], "Insert pastes the corrected draft exactly once")
        XCTAssertEqual(request("input")["input"] as? [String], [], "Insert must not press Enter")
        app.tapTerminalKey("Paste text")
        XCTAssertEqual(editor.value as? String, "", "Successful insertion clears the draft")
        app.buttons["Cancel"].tap()
    }
    func testSingleRowSwipeInputAndKeyboard() {
        _ = request("reset", reset: true)
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", base]; app.launch()
        XCTAssertTrue(app.buttons["session-alpha-local"].waitForExistence(timeout: 15))
        app.buttons["session-alpha-local"].tap()
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.6)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let strip = app.scrollViews["terminal-quick-keys"]
        XCTAssertTrue(strip.exists)
        capture("portrait-keyboard")
        let before = request("input")["input"] as? [String] ?? []
        strip.swipeLeft(); strip.swipeRight()
        XCTAssertEqual(request("input")["input"] as? [String] ?? [], before, "Dragging keys must not send input")
        let enter = app.revealTerminalKey("Enter")
        XCTAssertGreaterThanOrEqual(enter.frame.width, 44)
        XCTAssertLessThanOrEqual(strip.frame.height, 48)
        app.tapTerminalKey("Delete word")
        app.tapTerminalKey("Shift modifier")
        app.tapTerminalKey("Tab")
        app.tapTerminalKey("Control"); app.typeText("c")
        app.tapTerminalKey("Insert newline")
        let received = request("input")["input"] as? [String] ?? []
        XCTAssertEqual(Array(received.suffix(4)), ["\u{17}", "\u{1b}[Z", "\u{3}", "\n"])
        capture("scrolled-keyboard")
        app.tapTerminalKey("Hide keyboard")
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        capture("reading")
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.6)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        capture("landscape-keyboard")
        XCTAssertLessThanOrEqual(strip.frame.height, 48)
        XCUIDevice.shared.orientation = .portrait
        app.tapTerminalKey("Hide keyboard")
        XCTAssertTrue(app.buttons["available-media"].isHittable)
        XCTAssertGreaterThanOrEqual(app.buttons["available-media"].frame.height, 44)
        app.buttons["available-media"].tap()
        XCTAssertTrue(app.navigationBars["Media and links"].waitForExistence(timeout: 5))
        capture("media")
    }
    func testDirectShortcutDestinations() {
        _ = request("reset", reset: true)
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", base]; app.launch()
        XCTAssertTrue(app.buttons["session-alpha-local"].waitForExistence(timeout: 15))
        app.buttons["session-alpha-local"].tap()
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        app.tapTerminalKey("Number keys")
        XCTAssertTrue(app.navigationBars["Number keys"].waitForExistence(timeout: 5))
        app.buttons["7"].tap()
        XCTAssertEqual((request("input")["input"] as? [String])?.last, "7")
        app.buttons["Done"].tap()
        app.tapTerminalKey("Attach file")
        XCTAssertTrue(app.navigationBars["Attach to session"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        app.tapTerminalKey("Select text")
        XCTAssertTrue(app.navigationBars["Select text"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        app.tapTerminalKey("Enter")
        XCTAssertEqual((request("input")["input"] as? [String])?.last, "\r", "Leaving selection must restore terminal input")
    }

    func testActionsMenuKeepsScrollPositionDuringOutput() {
        _ = request("reset", reset: true)
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", base]; app.launch()
        XCTAssertTrue(app.buttons["session-alpha-local"].waitForExistence(timeout: 15))
        app.buttons["session-alpha-local"].tap()
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        app.buttons["Session actions"].tap()
        XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 5))
        let menu = app.collectionViews.allElementsBoundByIndex.last!
        // Pan within the clipped popup, without XCTest auto-scrolling to a row.
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let menuFrame = menu.frame
        let enclosing = app.otherElements.containing(NSPredicate(format: "elementType == %d", XCUIElement.ElementType.collectionView.rawValue))
            .allElementsBoundByIndex.map { $0.frame }.filter {
                abs($0.minX - menuFrame.minX) < 1 && abs($0.width - menuFrame.width) < 1 && $0.height > 0
            }.min { $0.height < $1.height }
        let frame = (enclosing ?? menuFrame).intersection(app.frame).insetBy(dx: 8, dy: 8)
        // At accessibility sizes the first swipe reaches management rows;
        // standard text reaches terminal rows. Both exercise the same popup.
        let candidates = ["Copy selection", "Copy server selection", "Exit copy mode", "Interrupt", "Delete word", "Insert newline", "Larger text", "Hibernate session", "Media and links", "Transcript"]
        var initialPositions: [String: CGFloat] = [:]
        for title in candidates where menu.buttons[title].exists {
            initialPositions[title] = menu.buttons[title].frame.minY
        }
        origin.withOffset(.init(dx: frame.midX, dy: frame.minY + frame.height * 0.75))
            .press(forDuration: 0, thenDragTo: origin.withOffset(.init(dx: frame.midX, dy: frame.minY + frame.height * 0.25)),
                   withVelocity: XCUIGestureVelocity(rawValue: 1000), thenHoldForDuration: 0.5)
        capture("menu-scrolled")
        guard let reference = candidates.compactMap({ title -> XCUIElement? in
            let item = menu.buttons[title]
            guard item.exists && item.isHittable else { return nil }
            if let initial = initialPositions[title], item.frame.minY >= initial - 10 { return nil }
            return item
        }).first else {
            add(XCTAttachment(string: app.debugDescription))
            XCTFail("No menu action moved into view after scrolling"); return
        }
        let before = reference.frame
        capture("menu-before-output")
        for _ in 0..<4 { _ = request("menu-update", reset: true) }
        // The fixture response only acknowledges transmission. Wait for a view
        // driven by the received metadata before measuring the still-open menu.
        XCTAssertTrue(app.buttons["Switch session, Alpha updated"].waitForExistence(timeout: 5))
        XCTAssertTrue(reference.exists)
        XCTAssertEqual(reference.frame.minY, before.minY, accuracy: 2, "Background output must not move an open menu")
        capture("menu-after-output")
        app.tapNativeMenuAction("Insert newline")
        XCTAssertEqual((request("input")["input"] as? [String])?.last, "\n")
        app.buttons["Session actions"].tap()
        app.tapNativeMenuAction("Switch session")
        XCTAssertTrue(app.buttons["Alpha updated"].waitForExistence(timeout: 5), "Reopening must use current session metadata")
        capture("menu-reopened")
    }

}
