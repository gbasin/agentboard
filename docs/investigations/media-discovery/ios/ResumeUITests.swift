import XCTest

final class ResumeUITests: XCTestCase {
    func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    func probe(_ stage: String = "") -> [String: Any] {
        let done = DispatchSemaphore(value: 0); var result: [String: Any] = [:]
        let endpoint = stage.isEmpty ? "metrics" : "stage?name=\(stage)"
        URLSession.shared.dataTask(with: URL(string: "http://127.0.0.1:5194/__probe/\(endpoint)")!) { data, _, _ in
            defer { done.signal() }
            if let data = data, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { result = value }
        }.resume()
        _ = done.wait(timeout: .now() + 10); return result
    }
    func navigate(_ app: XCUIApplication, _ url: String) {
        if app.keyboards.firstMatch.exists && app.buttons["Done"].exists { app.buttons["Done"].tap() }
        let address = app.textFields["Address"]; XCTAssertTrue(address.waitForExistence(timeout: 20)); address.tap(); app.typeText(url + "\n")
    }
    func testNativeDiscoveryLinksCopyAndResume() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari"); app.launch()
        let initial = probe()["items"] as! Int
        navigate(app, "http://100.82.11.20:59813/")
        let pill = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Open media")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 30))
        XCTAssertEqual(probe("closed")["items"] as? Int, initial)
        shot(app, "discovery-entrypoint")
        print("PILL " + pill.debugDescription); Thread.sleep(forTimeInterval: 2); pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let close = app.buttons["Collapse media rail"]; XCTAssertTrue(close.waitForExistence(timeout: 15))
        let media = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Media")).firstMatch
        XCTAssertTrue(media.exists)
        Thread.sleep(forTimeInterval: 3)
        shot(app, "discovery-media")
        let links = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Links")).firstMatch
        XCTAssertTrue(links.exists); links.tap()
        let copy = app.buttons["Copy link for Native complete URL"]
        XCTAssertTrue(copy.waitForExistence(timeout: 30))
        copy.tap()
        XCTAssertTrue(app.staticTexts["Link copied"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        shot(app, "links-copy-feedback")
        let before = probe("links-copied")["items"] as! Int
        XCUIDevice.shared.press(.home); Thread.sleep(forTimeInterval: 10)
        XCTAssertEqual(probe("backgrounded")["items"] as? Int, before)
        app.activate(); Thread.sleep(forTimeInterval: 8)
        XCTAssertTrue(close.exists); XCTAssertTrue(copy.exists)
        shot(app, "links-resumed")
        _ = probe("resumed")
        close.tap()
        let keyboard = app.buttons["Show keyboard"]
        if keyboard.exists { keyboard.tap() }
        let terminal = app.textViews["Terminal input"]; XCTAssertTrue(terminal.waitForExistence(timeout: 10)); terminal.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.typeText("IOS_DISCOVERY_FINAL_OK\n"); Thread.sleep(forTimeInterval: 2)
        shot(app, "discovery-terminal-input")
        let expected = probe()["expected"] as! String
        navigate(app, "http://100.82.11.20:59813/__probe/paste")
        let pasteTarget = app.textViews["Clipboard verification"]; XCTAssertTrue(pasteTarget.waitForExistence(timeout: 10))
        pasteTarget.tap(); pasteTarget.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"]
        if paste.waitForExistence(timeout: 3) { paste.tap() }
        else {
            let button = app.buttons["Paste"]; XCTAssertTrue(button.waitForExistence(timeout: 3)); button.tap()
        }
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(pasteTarget.value as? String, expected)
        shot(app, "full-url-pasted")
        print("NATIVE_FULL_URL_LENGTH=\(expected.count)")
        print("NATIVE_DISCOVERY_FINISHED\n" + app.debugDescription)
    }
}
