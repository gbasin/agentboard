import XCTest
final class ResumeUITests: XCTestCase {
 func shot(_ app: XCUIApplication, _ name: String) {
  let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)
 }
 func reload(_ app: XCUIApplication) {
  XCUIDevice.shared.press(.home);Thread.sleep(forTimeInterval:1);app.activate()
  let reload=app.buttons["ReloadButton"]
  XCTAssertTrue(reload.waitForExistence(timeout:5));reload.tap()
  Thread.sleep(forTimeInterval:3)
 }
 func testPersistentDraftReloadAndDiscard() throws {
  continueAfterFailure=false
  let app=XCUIApplication(bundleIdentifier:"com.apple.mobilesafari");app.launch()
  let address=app.textFields["Address"];XCTAssertTrue(address.waitForExistence(timeout:10));address.tap()
  app.typeText("http://127.0.0.1:5193/\n")
  let terminal=app.textViews["Terminal input"]
  XCTAssertTrue(terminal.waitForExistence(timeout:20));Thread.sleep(forTimeInterval:3);terminal.tap()
  print("IOS_PERSIST_READY_STOP_SERVER")
  XCTAssertTrue(app.staticTexts["reconnecting"].waitForExistence(timeout:120))
  terminal.tap();app.typeText("IOS_PERSIST_REVIEW\n")
  let draft=app.textViews.matching(NSPredicate(format:"label BEGINSWITH %@","Unsent text for")).firstMatch
  XCTAssertTrue(draft.waitForExistence(timeout:10))
  XCTAssertEqual(draft.value as? String,"IOS_PERSIST_REVIEW\n")
  let send=app.buttons["Send text"];XCTAssertFalse(send.isEnabled)
  shot(app,"persistent-draft-offline")
  print("IOS_PERSIST_CAPTURED_RESTART_SERVER")
  let ready=XCTNSPredicateExpectation(predicate:NSPredicate(format:"enabled == true"),object:send)
  XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:120),.completed)
  XCTAssertEqual(draft.value as? String,"IOS_PERSIST_REVIEW\n")
  reload(app)
  XCTAssertTrue(draft.waitForExistence(timeout:15))
  XCTAssertEqual(draft.value as? String,"IOS_PERSIST_REVIEW\n")
  let reready=XCTNSPredicateExpectation(predicate:NSPredicate(format:"enabled == true"),object:send)
  XCTAssertEqual(XCTWaiter.wait(for:[reready],timeout:20),.completed)
  shot(app,"persistent-draft-after-document-reload")
  print("IOS_PERSIST_RELOADED_CHECK_NO_SEND")
  Thread.sleep(forTimeInterval:15)
  app.buttons["Discard text"].tap()
  XCTAssertFalse(draft.exists)
  reload(app)
  XCTAssertFalse(draft.exists)
  XCTAssertFalse(send.exists)
  shot(app,"persistent-draft-discarded-reloaded")
  print("IOS_PERSIST_FINISHED\n"+app.debugDescription)
 }
}
