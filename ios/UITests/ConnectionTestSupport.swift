import XCTest

extension XCUIApplication {
    /// A WebView exists before WebKit and the server finish attaching the terminal.
    func waitForTerminalInput(timeout: TimeInterval) -> Bool {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: buttons["Enter"])
        return XCTWaiter.wait(for: [ready], timeout: timeout) == .completed
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
