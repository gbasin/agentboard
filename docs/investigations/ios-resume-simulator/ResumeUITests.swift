import XCTest

// Native Safari navigation and short background recovery. Run first.
final class ResumeUITests: XCTestCase {
    func testIntegratedSafariRecovery() throws {
        let app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        app.launch()
        let address = app.textFields["Address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        app.typeText("http://127.0.0.1:5190/\n")
        XCTAssertTrue(app.buttons["1"].waitForExistence(timeout: 15))
        app.buttons["1"].tap()
        let input = app.textViews["Terminal input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        input.tap()
        app.typeText("IOS_SAFARI_A_BEFORE_1024\n")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 4)
        app.activate()
        Thread.sleep(forTimeInterval: 2)
        input.tap()
        app.typeText("IOS_SAFARI_A_AFTER_1024\n")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "integrated-safari-resumed"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
