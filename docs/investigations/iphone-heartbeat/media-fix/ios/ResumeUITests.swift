import XCTest

final class ResumeUITests: XCTestCase {
    func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    func metric(_ stage: String = "") -> Int {
        let done = DispatchSemaphore(value: 0)
        var count = -1
        let endpoint = stage.isEmpty ? "metrics" : "stage?name=\(stage)"
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:5193/__probe/\(endpoint)")!) { data, _, _ in
            defer { done.signal() }
            if let data = data, let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                count = result["items"] as? Int ?? -1
            }
        }.resume()
        _ = done.wait(timeout: .now() + 10)
        return count
    }
    func testMediaScrollAndNativeResume() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        app.launch()
        let address = app.textFields["Address"]
        XCTAssertTrue(address.waitForExistence(timeout: 20))
        address.tap()
        app.typeText("http://127.0.0.1:5193/\n")
        Thread.sleep(forTimeInterval: 5)
        print("IOS_INITIAL_TREE\n" + app.debugDescription)
        let pill = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open media: 2366")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 30))
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(metric("closed"), 0)
        shot(app, "media-closed")
        pill.tap()
        XCTAssertTrue(app.buttons["Collapse media rail"].waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(metric("first-page"), 1)
        shot(app, "media-first-page")
        let rail = app.otherElements["Session media, oldest first"]
        print("IOS_MEDIA_TREE\n" + app.debugDescription)
        for _ in 0..<15 {
            if metric() >= 2 { break }
            if rail.exists { rail.swipeLeft() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.24)).press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.24))) }
        }
        Thread.sleep(forTimeInterval: 2)
        let before = metric("scrolled")
        XCTAssertGreaterThanOrEqual(before, 2)
        shot(app, "media-scrolled")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 10)
        XCTAssertEqual(metric("backgrounded"), before)
        app.activate()
        Thread.sleep(forTimeInterval: 8)
        XCTAssertTrue(app.buttons["Collapse media rail"].exists)
        XCTAssertEqual(metric("resumed"), before)
        shot(app, "media-resumed")
        app.buttons["Collapse media rail"].tap()
        let keyboard = app.buttons["Show keyboard"]
        if keyboard.exists {
            if !keyboard.isHittable { app.swipeLeft() }
            keyboard.tap()
        }
        let terminal = app.textViews["Terminal input"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        terminal.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.typeText("IOS_MEDIA_NATIVE_OK\n")
        Thread.sleep(forTimeInterval: 2)
        shot(app, "media-terminal-input")
        print("IOS_MEDIA_FINISHED\n" + app.debugDescription)
    }
}
