import XCTest
import UIKit
import UniformTypeIdentifiers

/// Reads the real simulator pasteboard; no application launch backdoor or production session.
final class NativeClipboardUITests: XCTestCase {
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return }
            (app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? app.collectionViews.firstMatch).swipeUp()
        }
        if !element.exists || !element.isHittable {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "clipboard-unreachable-session"; screenshot.lifetime = .keepAlways; add(screenshot)
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "clipboard-unreachable-session-hierarchy"; tree.lifetime = .keepAlways; add(tree)
        }
        XCTAssertTrue(element.exists, "Missing session after scrolling")
        XCTAssertTrue(element.isHittable, "Session is not hittable after scrolling")
    }
    func testMixedClipboardReviewRemovesImageAndInsertsWithoutEnter() {
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
        UIPasteboard.general.items = [[UTType.utf8PlainText.identifier: marker], [UTType.png.identifier: png], [UTType.png.identifier: png]]
        defer { UIPasteboard.general.items = [] }
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]; app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 15))
        let search = app.searchFields["Find a session"]; search.tap(); search.typeText("native-live-one\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "native-live-one")).firstMatch
        reveal(row, in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10)); XCTAssertTrue(row.isHittable); row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["Enter"])
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed, app.debugDescription)
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.6)).tap()
        app.tapTerminalKey("Control"); app.typeText("u")
        app.tapTerminalKey("Paste text")
        app.buttons["Paste from clipboard"].tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        defer {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "clipboard-final-state"; attachment.lifetime = .keepAlways; add(attachment)
        }
        // xterm exposes each wrapped screen row separately. Join rows and ignore
        // wrapping whitespace, requiring this run's unique marker followed by its image path.
        XCTAssertTrue(app.buttons["confirm-attachments"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["remove-attachment-1"].waitForExistence(timeout: 5))
        let remove = app.buttons["remove-attachment-1"]
        for _ in 0..<6 {
            if remove.isHittable { break }
            app.scrollViews["attachment-previews"].swipeUp()
        }
        remove.tap()
        XCTAssertFalse(app.buttons["remove-attachment-1"].exists)
        let review = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); review.name = "clipboard-attachment-review"; review.lifetime = .keepAlways; add(review)
        app.buttons["confirm-attachments"].tap()
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
        app.tapTerminalKey("Control"); app.typeText("u")
    }
}
