import XCTest

/// Mutates only uniquely named disposable shells on the private port-4151 backend.
final class SessionActionUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func capture(_ name: String) {
        sleep(1)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func replace(_ field: XCUIElement, with value: String, in app: XCUIApplication) {
        field.tap()
        sleep(1) // Wait for the native field to finish scrolling above the keyboard.
        for _ in 0..<4 {
            field.typeKey("a", modifierFlags: .command)
            field.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
            if (field.value as? String ?? "") == "" || (field.value as? String) == field.placeholderValue { break }
        }
        field.typeText(value)
        XCTAssertEqual(field.value as? String, value)
    }
    private func openAction(_ title: String, in app: XCUIApplication) {
        app.buttons["Session actions"].tap()
        // Native menus scroll at accessibility sizes; locate the requested action.
        let end = app.buttons[title]
        for _ in 0..<8 {
            if end.exists && end.isHittable { break }
            (app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? app.collectionViews.firstMatch).swipeUp()
        }
        end.tap()
    }
    func testCreateRenameCancelAndEndLiveSession() {
        let app = XCUIApplication()
        app.launchArguments = ["-serverURL", "http://127.0.0.1:4151"]
        app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 15))
        app.buttons["New session"].tap()
        XCTAssertTrue(app.buttons["Create"].isEnabled)
        let name = "ios-actions-" + String(UUID().uuidString.prefix(6))
        let project = app.textFields["session-project"]
        replace(project, with: "/ab-missing", in: app)
        replace(app.textFields["session-command"], with: "/bin/zsh", in: app)
        app.textFields["session-name"].tap(); app.textFields["session-name"].typeText(name)
        capture("actions-create")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["action-error"].firstMatch.waitForExistence(timeout: 10))
        capture("actions-error")
        replace(project, with: "/tmp", in: app)
        app.buttons["Create"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["Enter"])
        waitForExpectations(timeout: 15)
        openAction("Rename session", in: app)
        replace(app.textFields["session-name"], with: name + "-renamed", in: app)
        capture("actions-rename")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", name + "-renamed")).firstMatch.waitForExistence(timeout: 10))
        openAction("End session", in: app)
        capture("actions-end")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.webViews.firstMatch.exists)
        openAction("End session", in: app)
        app.buttons["confirm-end-session"].tap()
        XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch.exists)
        capture("actions-ended")
    }
}
