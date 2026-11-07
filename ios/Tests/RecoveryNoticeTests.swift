import XCTest
@testable import AgentboardSpike

@MainActor
final class RecoveryNoticeTests: XCTestCase {
    private func health(_ ids: [String]?, error: String? = nil) -> LibraryHealth {
        var value = LibraryHealth(interrupted: ids?.count ?? 2, error: error, matchingAvailable: true, matchingError: nil, settings: .init(autoResume: false, capturePreviews: true))
        value.interruptedIds = ids
        return value
    }
    func testDismissalIsScopedToKnownInterruptionsAndServer() async {
        let name = "recovery-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let model = RecoveryNoticeModel(defaults: defaults)
        await model.refresh("http://one") { _ in self.health(["a"]) }
        XCTAssertEqual(model.pendingCount, 1)
        model.dismiss(); XCTAssertFalse(model.visible)
        await model.refresh("http://one") { _ in self.health(["a", "b"]) }
        XCTAssertEqual(model.pendingIDs, ["b"])
        await model.refresh("http://two") { _ in self.health(["a"]) }
        XCTAssertTrue(model.visible)
        await model.refresh("http://one") { _ in self.health(["a"]) }
        XCTAssertFalse(model.visible)
        await model.refresh("http://one") { _ in self.health([], error: "Storage unavailable") }
        XCTAssertTrue(model.visible)
        model.dismiss(); XCTAssertFalse(model.visible)
        await model.refresh("http://one") { _ in self.health([], error: "Different failure") }
        XCTAssertTrue(model.visible)
    }
    func testOlderServerWithoutIDsAndSuccessfulRecovery() async {
        let name = "recovery-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let model = RecoveryNoticeModel(defaults: defaults)
        await model.refresh("http://one") { _ in self.health(nil) }
        XCTAssertEqual(model.pendingCount, 2)
        model.dismiss(); XCTAssertFalse(model.visible)
        await model.refresh("http://one") { _ in self.health([]) }
        XCTAssertFalse(model.visible)
    }
}
