import XCTest
final class ResumeUITests: XCTestCase {
 func testOfflineKeyboardFullControl() throws {
  continueAfterFailure = false
  let app=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari");app.activate()
  let enter=app.buttons["Enter"]
  let start=enter.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5)).withOffset(CGVector(dx:310,dy:0))
  start.press(forDuration:0.1,thenDragTo:enter.coordinate(withNormalizedOffset:CGVector(dx:0.5,dy:0.5)))
  let keyboard=app.buttons["Show keyboard"]
  print("KEYBOARD_FRAME "+String(describing:keyboard.frame))
  XCTAssertTrue(keyboard.isEnabled)
  keyboard.tap()
  let shot=XCTAttachment(screenshot:app.screenshot());shot.name="offline-keyboard-full-control";shot.lifetime = .keepAlways;add(shot)
  print(app.debugDescription)
  XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:5))
 }
}
