import XCTest
final class ResumeUITests: XCTestCase {
 func testIntegratedHomeScreenRecovery() throws {
 let safari=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari");safari.launch()
 if safari.buttons["Done"].exists {safari.buttons["Done"].tap()}
 safari.buttons["MoreMenuButton"].tap()
 safari.buttons["ShareButton"].tap()
 if safari.cells["View More"].exists {safari.cells["View More"].tap()}
 safari.cells["Add to Home Screen"].tap()
 safari.buttons["Add"].tap()
 XCUIDevice.shared.press(.home)
 let board=XCUIApplication(bundleIdentifier:"com.apple.springboard")
 let icon=board.icons["Agentboard"]
 for _ in 0..<3 {if icon.isHittable {break};board.swipeLeft()}
 XCTAssertTrue(icon.waitForExistence(timeout:5));icon.tap()
 let app=XCUIApplication(bundleIdentifier:"com.apple.webapp")
 XCTAssertTrue(app.buttons["1"].waitForExistence(timeout:10));app.buttons["1"].tap()
 let input=app.textViews["Terminal input"]
 Thread.sleep(forTimeInterval:2);input.tap();app.typeText("IOS_HOME_A_BEFORE_1024\n")
 XCUIDevice.shared.press(.home);Thread.sleep(forTimeInterval:45);icon.tap()
 Thread.sleep(forTimeInterval:2);input.tap();app.typeText("IOS_HOME_A_AFTER_1024\n")
 app.buttons["2"].tap();Thread.sleep(forTimeInterval:1);input.tap();app.typeText("IOS_HOME_B_SWITCH_1024\n")
 print("APP_TREE_BEGIN\n"+app.debugDescription+"\nAPP_TREE_END")
 let shot=XCTAttachment(screenshot:app.screenshot());shot.name="integrated-home-resumed";shot.lifetime = .keepAlways;add(shot)
 }
}
