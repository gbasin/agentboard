import XCTest

final class ResumeUITests: XCTestCase {
    func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testRecoveryDraftRequiresExplicitSend() throws {
        let app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        app.launch()
        let address = app.textFields["Address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        app.typeText("http://127.0.0.1:5192/\n")
        let terminal = app.textViews["Terminal input"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)
        terminal.tap()
        print("IOS_STAGE_READY_FOR_SERVER_STOP")
        let reconnecting = app.staticTexts["reconnecting"]
        XCTAssertTrue(reconnecting.waitForExistence(timeout: 90))
        terminal.tap()
        app.typeText("IOS_DRAFT_REVIEW\n")
        let draft = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "Unsent text for")).firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 10))
        XCTAssertEqual(draft.value as? String, "IOS_DRAFT_REVIEW\n")
        let send = app.buttons["Send text"]
        XCTAssertFalse(send.isEnabled)
        shot(app, "ios-draft-offline")
        print("IOS_STAGE_DRAFT_CAPTURED_RESTART_SERVER")
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: send)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 120), .completed)
        XCTAssertEqual(draft.value as? String, "IOS_DRAFT_REVIEW\n")
        shot(app, "ios-draft-reconnected-unsent")
        print("IOS_STAGE_RECONNECTED_CHECK_PANE_BEFORE_SEND")
        Thread.sleep(forTimeInterval: 20)
        XCTAssertEqual(draft.value as? String, "IOS_DRAFT_REVIEW\n")
        send.tap()
        XCTAssertFalse(draft.exists)
        print("IOS_STAGE_EXPLICIT_SEND_COMPLETE")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 5)
        app.activate()
        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(app.buttons["Send text"].exists)
        shot(app, "ios-draft-sent-resumed")
        print("IOS_STAGE_FINISHED\n" + app.debugDescription)
    }
}
