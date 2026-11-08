import XCTest
@testable import AgentboardSpike

final class TerminalSelectionTests: XCTestCase {
    func testReplacementEditsOnlyCommittedSuffix() {
        var buffer = TerminalEditBuffer()
        XCTAssertEqual(buffer.replace(with: "teh"), "teh")
        XCTAssertEqual(buffer.replace(with: "the "), "\u{7f}\u{7f}\u{1b}[200~he \u{1b}[201~")
        XCTAssertEqual(buffer.replace(with: "the "), "")
        XCTAssertEqual(buffer.replace(with: "the"), "\u{7f}")
        XCTAssertEqual(buffer.replace(with: "the\n"), "\r")
    }
    func testResetDoesNotEraseEarlierTerminalInput() {
        var buffer = TerminalEditBuffer()
        _ = buffer.replace(with: "old command")
        buffer.reset()
        XCTAssertEqual(buffer.replace(with: "new"), "new")
    }
    func testReplacementMatchesPWACodePointDeletion() {
        var buffer = TerminalEditBuffer()
        _ = buffer.replace(with: "a👩‍💻e\u{301}")
        XCTAssertEqual(buffer.replace(with: "ab"), String(repeating: "\u{7f}", count: 5) + "\u{1b}[200~b\u{1b}[201~")
    }
    func testSharedCopyPreservesRelativeCodeIndent() {
        let text = "  if ready {  \n    run()\n  }\n"
        XCTAssertEqual(SnapshotCopy.text(text, range: NSRange(location: 0, length: (text as NSString).length), columns: 80, rejoin: false), "if ready {\n  run()\n}")
    }
    func testSharedCopyUsesUTF16SelectionOffsets() {
        let text = "  👩‍💻 hello world"
        let range = (text as NSString).range(of: "hello")
        XCTAssertEqual(SnapshotCopy.text(text, range: range, columns: 80, rejoin: false), "hello")
    }
    @MainActor func testSnapshotIgnoresOtherSessionAndRequest() async throws {
        let request = TerminalSnapshotRequest()
        let capture = Task {
            try await request.capture(session: "one") { id in
                request.receive(TerminalSnapshotReply(sessionId: "two", requestId: id, ok: true, text: "wrong", altScreen: false, historyLines: 0, scrollPosition: 0))
                request.receive(TerminalSnapshotReply(sessionId: "one", requestId: id + 1, ok: true, text: "wrong", altScreen: false, historyLines: 0, scrollPosition: 0))
                request.receive(TerminalSnapshotReply(sessionId: "one", requestId: id, ok: true, text: "correct", altScreen: false, historyLines: 0, scrollPosition: 0))
            }
        }
        let reply = try await capture.value
        XCTAssertEqual(reply.text, "correct")
    }
    @MainActor func testSnapshotCancellationReleasesWaiter() async {
        let request = TerminalSnapshotRequest()
        do {
            _ = try await request.capture(session: "one") { _ in request.cancel() }
            XCTFail("Expected cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
    }
}
