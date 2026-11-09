import XCTest

/// Verifies the scrolling strip against an isolated protocol fixture, including drag cancellation.
final class CompactTerminalUITests: XCTestCase {
    private let base = "http://127.0.0.1:4192"
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
        origin.withOffset(.init(dx: frame.midX, dy: frame.minY + frame.height * 0.75))
            .press(forDuration: 0, thenDragTo: origin.withOffset(.init(dx: frame.midX, dy: frame.minY + frame.height * 0.25)),
                   withVelocity: XCUIGestureVelocity(rawValue: 1000), thenHoldForDuration: 0.5)
        capture("menu-scrolled")
        let candidates = ["Copy selection", "Copy server selection", "Exit copy mode", "Interrupt", "Delete word", "Insert newline", "Larger text"]
        guard let reference = candidates.map({ menu.buttons[$0] }).first(where: { $0.exists && $0.isHittable }) else {
            add(XCTAttachment(string: app.debugDescription))
            XCTFail("No terminal action visible after scrolling"); return
        }
        let before = reference.frame
        capture("menu-before-output")
        for _ in 0..<4 { _ = request("menu-update", reset: true) }
        // A fresh accessibility read waits for the received UI updates to settle.
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
