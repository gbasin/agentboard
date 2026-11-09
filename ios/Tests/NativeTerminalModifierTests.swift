import XCTest
@testable import AgentboardSpike

final class NativeTerminalModifierTests: XCTestCase {
    func testShiftReturnInsertsLFInsteadOfSubmittingCR() {
        XCTAssertEqual(Array(NativeTerminalModifiers.applyingShift(to: "\r", active: true).utf8), [10])
        XCTAssertEqual(Array(NativeTerminalModifiers.applyingShift(to: "\r", active: false).utf8), [13])
    }
    func testShiftTabUsesReverseTabSequence() {
        XCTAssertEqual(Array(NativeTerminalModifiers.applyingShift(to: "\t", active: true).utf8), [27, 91, 90])
        XCTAssertEqual(NativeTerminalModifiers.applyingShift(to: "\t", active: false), "\t")
    }
    func testShiftPreservesAlreadyModifiedKeysAndUnicode() {
        for input in ["\u{1b}[A", "\u{1b}[Z", "\n", "\u{3}", "Hello 👋", "é"] {
            XCTAssertEqual(NativeTerminalModifiers.applyingShift(to: input, active: true), input)
        }
    }
    @MainActor func testShiftConsumedByInputAndResetOnDismissal() {
        let terminal = TerminalBridge()
        terminal.toggleShift()
        XCTAssertTrue(terminal.shift)
        terminal.send("\t")
        XCTAssertFalse(terminal.shift)
        terminal.toggleShift()
        terminal.hideKeyboard()
        XCTAssertFalse(terminal.shift)
    }
    func testMediaCountsUseWireKindsAndKeepUnknownFilesVisible() throws {
        let items = try JSONDecoder().decode([MediaItem].self, from: Data("""
        [{"kind":"image","url":"/one"},{"kind":"link","url":"https://example.com"},
         {"kind":"document","url":"/two"},{"kind":"attachment","url":"/three"}]
        """.utf8))
        let summary = NativeMediaSummary(items: items)
        XCTAssertEqual(summary.images, 1)
        XCTAssertEqual(summary.links, 1)
        XCTAssertEqual(summary.files, 2)
        XCTAssertEqual(summary.total, 4)
        XCTAssertTrue(summary.accessibilityDescription.hasPrefix("Available media:"))
        XCTAssertEqual(NativeMediaSummary(items: []).total, 0)
    }
}
