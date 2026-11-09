import XCTest

extension XCUIApplication {
    /// A WebView exists before WebKit and the server finish attaching the terminal.
    func waitForTerminalInput(timeout: TimeInterval) -> Bool {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: buttons["Enter"])
        return XCTWaiter.wait(for: [ready], timeout: timeout) == .completed
    }

    /// Connection status now lives in the native toolbar button's accessible value.
    func waitForBoardConnection(timeout: TimeInterval) -> Bool {
        let status = buttons["connection-status"]
        let connected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'Connected'"), object: status)
        return XCTWaiter.wait(for: [connected], timeout: timeout) == .completed
    }
}

extension XCUIApplication {
    /// Scroll a key fully into the strip before tapping. XCTest's automatic hit-point
    /// resolution can throw for offscreen SwiftUI buttons after rotation.
    func revealTerminalKey(_ name: String) -> XCUIElement {
        let strip = scrollViews["terminal-quick-keys"]
        let key = strip.buttons[name].firstMatch
        XCTAssertTrue(strip.waitForExistence(timeout: 5))
        for _ in 0..<12 {
            if key.exists {
                let frame = key.frame
                let visible = strip.frame.intersection(self.frame)
                if !frame.isEmpty && visible.contains(frame) { return key }
                if frame.midX < visible.midX { strip.swipeRight() } else { strip.swipeLeft() }
            } else { strip.swipeLeft() }
        }
        XCTFail("Could not reveal terminal key: \(name)")
        return key
    }
    func tapTerminalKey(_ name: String) {
        let frame = revealTerminalKey(name).frame
        coordinate(withNormalizedOffset: .zero).withOffset(.init(dx: frame.midX, dy: frame.midY)).tap()
    }
}
