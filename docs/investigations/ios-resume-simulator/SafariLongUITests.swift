import XCTest
final class ResumeUITests: XCTestCase {
 func testIntegratedSafariLongRecovery() throws {
 let app=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari");app.launch()
 app.buttons["2"].tap()
 let input=app.textViews["Terminal input"]
 Thread.sleep(forTimeInterval:2)
 input.tap();app.typeText("IOS_SAFARI_B_BEFORE_LONG_1024\n")
 XCUIDevice.shared.press(.home);Thread.sleep(forTimeInterval:45);app.activate()
 Thread.sleep(forTimeInterval:2)
 input.tap();app.typeText("IOS_SAFARI_B_AFTER_LONG_1024\n")
 app.buttons["1"].tap();Thread.sleep(forTimeInterval:1)
 input.tap();app.typeText("IOS_SAFARI_A_SWITCH_BACK_1024\n")
 print("APP_TREE_BEGIN\n"+app.debugDescription+"\nAPP_TREE_END")
 let shot=XCTAttachment(screenshot:app.screenshot());shot.name="integrated-safari-resumed";shot.lifetime = .keepAlways;add(shot)
 }
}

