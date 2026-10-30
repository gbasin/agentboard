import XCTest

final class ResumeUITests: XCTestCase {
    func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testReopenedKeyboardDraftSend() throws {
        let app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        app.activate()
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        app.typeText("IOS_REOPEN_REVIEW\n")
        let draft = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "Unsent text for")).firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        XCTAssertEqual(draft.value as? String, "IOS_REOPEN_REVIEW\n")
        let send = app.buttons["Send text"]
        XCTAssertFalse(send.isEnabled)
        shot(app, "ios-reopen-offline")
        print("IOS_STAGE_DRAFT_CAPTURED_RESTART_SERVER")
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: send)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 120), .completed)
        XCTAssertEqual(draft.value as? String, "IOS_REOPEN_REVIEW\n")
        shot(app, "ios-reopen-reconnected-unsent")
        print("IOS_STAGE_RECONNECTED_CHECK_PANE_BEFORE_SEND")
        Thread.sleep(forTimeInterval: 20)
        XCTAssertEqual(draft.value as? String, "IOS_REOPEN_REVIEW\n")
        send.tap()
        XCTAssertFalse(draft.exists)
        print("IOS_STAGE_EXPLICIT_SEND_COMPLETE")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 5)
        app.activate()
        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(app.buttons["Send text"].exists)
        shot(app, "ios-reopen-sent-resumed")
        print("IOS_STAGE_FINISHED\n" + app.debugDescription)
    }
}
