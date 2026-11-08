import XCTest

extension XCUIApplication {
    /// Connection status now lives in the native toolbar button's accessible value.
    func waitForBoardConnection(timeout: TimeInterval) -> Bool {
        let status = buttons["connection-status"]
        let connected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'Connected'"), object: status)
        return XCTWaiter.wait(for: [connected], timeout: timeout) == .completed
    }
}
