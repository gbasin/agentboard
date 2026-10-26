import XCTest
final class ResumeUITests: XCTestCase {
 func testFinalBuildSafariAndHome() throws {
 let safari=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari");safari.launch()
 XCTAssertTrue(safari.buttons["2"].waitForExistence(timeout:10));safari.buttons["2"].tap()
 Thread.sleep(forTimeInterval:2)
 safari.textViews["Terminal input"].tap();safari.typeText("IOS_FINAL_SAFARI_B_1024\n")
 let web=XCUIApplication(bundleIdentifier:"com.apple.webapp");web.terminate()
 XCUIDevice.shared.press(.home)
 let board=XCUIApplication(bundleIdentifier:"com.apple.springboard")
 let icon=board.icons["Agentboard"]
 for _ in 0..<3 {if icon.isHittable {break};board.swipeLeft()}
 XCTAssertTrue(icon.waitForExistence(timeout:5));icon.tap()
 XCTAssertTrue(web.buttons["2"].waitForExistence(timeout:10))
 Thread.sleep(forTimeInterval:2)
 web.textViews["Terminal input"].tap();web.typeText("IOS_FINAL_HOME_RELAUNCH_B_1024\n")
 XCUIDevice.shared.press(.home);Thread.sleep(forTimeInterval:4);icon.tap()
 Thread.sleep(forTimeInterval:2)
 web.textViews["Terminal input"].tap();web.typeText("IOS_FINAL_HOME_RESUME_B_1024\n")
 let shot=XCTAttachment(screenshot:web.screenshot());shot.name="final-home-relaunched-resumed";shot.lifetime = .keepAlways;add(shot)
 print("FINAL_APP_TREE\n"+web.debugDescription)
 }
}
