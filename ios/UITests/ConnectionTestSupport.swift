import XCTest

/// Terminal attach spans a tmux client, the WebSocket, and WebKit, and is
/// slow on a loaded CI runner. Use one budget for every attach wait.
let terminalAttachTimeout: TimeInterval = 60

extension XCUIApplication {
    /// A WebView exists before WebKit and the server finish attaching the terminal.
    func waitForTerminalInput(timeout: TimeInterval = terminalAttachTimeout) -> Bool {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: buttons["Enter"])
        return XCTWaiter.wait(for: [ready], timeout: timeout) == .completed
    }

    /// Tap until the software keyboard appears. Under CI load the first tap can
    /// reach WebKit before it accepts focus, and a fixed short wait then fails.
    /// Re-tap only after ten quiet seconds. Use for WebView coordinate taps only;
    /// a re-tap on a native text view can open its edit menu, so native fields
    /// use focusForTyping().
    func showKeyboard(timeout: TimeInterval = 30, by tap: () -> Void) -> Bool {
        let keyboard = keyboards.firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            tap()
            if keyboard.waitForExistence(timeout: min(10, max(1, deadline.timeIntervalSinceNow))) { return true }
        } while Date() < deadline
        return keyboard.exists
    }

    /// Allow each launch phase its own budget: toolbar registration, then connection.
    func waitForBoardConnection(timeout: TimeInterval) -> Bool {
        let status = buttons["connection-status"]
        guard status.waitForExistence(timeout: timeout) else {
            attachConnectionState("connection-toolbar-missing")
            return false
        }
        let connected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "Connection, Connected"), object: status)
        let ready = XCTWaiter.wait(for: [connected], timeout: timeout) == .completed
        if !ready { attachConnectionState("connection-state-timeout") }
        return ready
    }

    private func attachConnectionState(_ name: String) {
        XCTContext.runActivity(named: name) { activity in
            let hierarchy = XCTAttachment(string: debugDescription)
            hierarchy.name = name; hierarchy.lifetime = .keepAlways
            activity.add(hierarchy)
        }
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
