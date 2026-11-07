import XCTest
import UIKit
import UniformTypeIdentifiers

/// Reads the real simulator pasteboard; no application launch backdoor or production session.
final class NativeClipboardUITests: XCTestCase {
    func testMixedClipboardImageAndTextInsertsWithoutEnter() {
        continueAfterFailure = false
        executionTimeAllowance = 90
        let monitor = addUIInterruptionMonitor(withDescription: "Clipboard permission") { _ in
            let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]
            if allow.exists { allow.tap(); return true }
            return false
        }
        defer { removeUIInterruptionMonitor(monitor) }
        let marker = "CLIPBOARD_PARITY_" + String(UUID().uuidString.prefix(8))
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
        let png = renderer.pngData { context in UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
        UIPasteboard.general.items = [[UTType.utf8PlainText.identifier: marker], [UTType.png.identifier: png]]
        defer { UIPasteboard.general.items = [] }
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]; app.launch()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 15))
        let search = app.searchFields["Find a session"]; search.tap(); search.typeText("native-live-one\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "native-live-one")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.6)).tap()
        app.buttons["Control"].tap(); app.typeText("u")
        app.buttons["Paste text"].tap()
        app.buttons["Paste from clipboard"].tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        defer {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "clipboard-final-state"; attachment.lifetime = .keepAlways; add(attachment)
        }
        // xterm exposes each wrapped screen row separately. Join rows and ignore
        // wrapping whitespace, requiring this run's unique marker followed by its image path.
        let pair = marker + "/tmp/paste-"
        let inserted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let text = app.webViews.staticTexts.allElementsBoundByIndex.map(\.label).joined()
            return text.filter { !$0.isWhitespace }.contains(pair)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [inserted], timeout: 15), .completed)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); attachment.name = "clipboard-image-and-text"; attachment.lifetime = .keepAlways; add(attachment)
        // An executed bare marker would fail in zsh; insertion must leave it in the prompt.
        let output = app.webViews.staticTexts.allElementsBoundByIndex.map(\.label).joined().filter { !$0.isWhitespace }
        XCTAssertFalse(output.contains("commandnotfound:" + marker))
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.6)).tap()
        app.buttons["Control"].tap(); app.typeText("u")
    }
}
