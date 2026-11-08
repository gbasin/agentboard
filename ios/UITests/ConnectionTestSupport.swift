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
