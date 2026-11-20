import XCTest

/// Poll until `condition` holds. XCTWaiter evaluates a block predicate on its
/// own schedule and discards a check that returns true after its deadline; on a
/// loaded runner one accessibility snapshot of a remote sheet or menu can take
/// longer than the whole window. Here a check that started in time still counts.
@discardableResult
func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
        if condition() { return true }
        if Date() >= deadline { return false }
        Thread.sleep(forTimeInterval: 0.25)
    }
}

extension XCUIElement {
    /// Static text labels below this element, read from one accessibility
    /// snapshot. `staticTexts.allElementsBoundByIndex` resolves every element
    /// with its own query, which repeats the snapshot once per text.
    var staticTextLabels: [String] {
        guard let root = try? snapshot() else { return [] }
        var labels: [String] = []
        func collect(_ node: XCUIElementSnapshot) {
            if node.elementType == .staticText { labels.append(node.label) }
            node.children.forEach(collect)
        }
        collect(root)
        return labels
    }
}

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

    /// A stalled runner can drop the software keyboard without a hide
    /// notification, taking terminal focus with it. Restore focus first.
    func typeIntoTerminal(_ text: String) {
        if !keyboards.firstMatch.exists {
            XCTAssertTrue(showKeyboard { webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.6)).tap() })
        }
        typeText(text)
    }

    /// Allow each launch phase its own budget: toolbar registration, then connection.
    /// On a saturated runner one label check has taken 14 s while the backend
    /// event loop stalled for 10 s, so each phase gets at least 45 s.
    func waitForBoardConnection(timeout: TimeInterval) -> Bool {
        let status = buttons["connection-status"]
        let budget = max(timeout, 45)
        guard waitUntil(timeout: budget, { status.exists }) else {
            attachConnectionState("connection-toolbar-missing")
            return false
        }
        let ready = waitUntil(timeout: budget) { status.label == "Connection, Connected" }
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
