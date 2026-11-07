import XCTest

/// Runs every native destination against the private backend seeded by seed-parity.ts.
final class NativeParityUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    private func app(server: String = "http://127.0.0.1:4151") -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", server]; app.launch()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 15)); return app
    }
    private func capture(_ name: String) {
        sleep(1); let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "parity-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func replace(_ field: XCUIElement, _ value: String) {
        field.tap(); sleep(1)
        for _ in 0..<4 {
            field.typeKey("a", modifierFlags: .command); field.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
            if (field.value as? String ?? "") == "" || (field.value as? String) == field.placeholderValue { break }
        }
        field.typeText(value)
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<10 {
            if element.exists && element.isHittable { return }
            (app.collectionViews.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? app.collectionViews.firstMatch).swipeUp()
        }
        XCTAssertTrue(element.exists, "Missing \(element)")
    }
    private func tap(_ title: String, in app: XCUIApplication) {
        let button = app.buttons[title]; reveal(button, in: app); button.tap()
    }
    private func search(_ value: String, in app: XCUIApplication) {
        let search = app.searchFields["Search saved sessions"]; XCTAssertTrue(search.waitForExistence(timeout: 5)); replace(search, value); search.typeText("\n")
    }
    private func openSession(_ name: String, in app: XCUIApplication) {
        let field = app.searchFields["Find a session"]
        replace(field, name); field.typeText("\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
    }
    func testDirectoryBrowserPresetAndDuplicate() {
        let app = app(); app.buttons["New session"].tap()
        XCTAssertTrue(app.textFields["session-command"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["session-command"].value as? String, "/bin/zsh -f")
        replace(app.textFields["session-project"], "/tmp/ab-ios-parity/project")
        tap("Browse directories", in: app)
        XCTAssertTrue(app.navigationBars["Choose directory"].waitForExistence(timeout: 5))
        app.buttons["child"].tap(); app.buttons["Parent directory"].tap(); capture("directories")
        app.buttons["Choose"].tap()
        let name = "parity-ui-" + String(UUID().uuidString.prefix(6))
        app.textFields["session-name"].tap(); app.textFields["session-name"].typeText(name)
        capture("create-presets")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        app.buttons["Session actions"].tap(); tap("Duplicate session", in: app)
        XCTAssertTrue(app.textFields["session-command"].waitForExistence(timeout: 5))
        XCTAssertTrue((app.textFields["session-project"].value as? String ?? "").hasSuffix("/tmp/ab-ios-parity/project"))
        app.buttons["Cancel"].tap()
        app.buttons["Session actions"].tap(); tap("Hibernate session", in: app)
        app.buttons["confirm-end-session"].tap()
        XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 15))
        app.buttons["Library"].tap(); search(name, in: app)
        let row = app.buttons["saved-" + name]; XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        XCTAssertTrue(app.buttons["Resume session"].waitForExistence(timeout: 5)); capture("saved-sleeping")
        app.buttons["Resume session"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        capture("resumed-terminal")
    }
    func testLibraryTranscriptEventsAndPin() {
        let app = app(); app.buttons["Library"].tap(); search("parity-saved-transcript", in: app)
        let row = app.buttons["saved-parity-saved-transcript"]; XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
        tap("Pin", in: app)
        tap("Unpin", in: app)
        capture("saved-detail")
        tap("parity-saved-transcript", in: app)
        XCTAssertTrue(app.navigationBars["Transcript"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS %@", "Parity transcript message", "Review https://")).firstMatch.waitForExistence(timeout: 10))
        capture("transcript-messages")
        app.buttons["Events"].tap(); capture("transcript-events")
        app.buttons["Messages"].tap()
        for _ in 0..<20 {
            if app.buttons["Load earlier"].isHittable { break }
            app.collectionViews.firstMatch.swipeUp(velocity: .fast)
        }
        XCTAssertTrue(app.buttons["Load earlier"].exists); app.buttons["Load earlier"].tap()
    }
    func testSettingsFiltersAndTerminalDestinations() {
        let app = app(); app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5)); capture("settings")
        tap("Command presets", in: app); tap("Add preset", in: app)
        app.textFields["Label"].tap(); app.textFields["Label"].typeText("Parity preset")
        app.textFields["Command"].tap(); app.textFields["Command"].typeText("/bin/zsh -f"); capture("preset-editor")
        app.buttons["Save"].tap(); XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Parity preset")).firstMatch.waitForExistence(timeout: 10))
        capture("presets")
        app.navigationBars.buttons.element(boundBy: 0).tap(); app.buttons["Done"].tap()
        app.buttons["Filter and sort"].tap(); XCTAssertTrue(app.navigationBars["Filter and sort"].waitForExistence(timeout: 5)); capture("filters")
        tap("Clear filters", in: app); app.buttons["Done"].tap()
        openSession("native-live-one", in: app)
        app.buttons["Session actions"].tap(); tap("Media and links", in: app)
        XCTAssertTrue(app.navigationBars["Media and links"].waitForExistence(timeout: 5)); capture("media-empty"); app.buttons["Done"].tap()
        app.buttons["Session actions"].tap(); tap("Attach file", in: app)
        XCTAssertTrue(app.buttons["Choose file"].waitForExistence(timeout: 5)); capture("attach-file")
        app.buttons["Choose file"].tap(); XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5)); app.buttons["Cancel"].tap(); app.buttons["Done"].tap()
        app.buttons["Paste text"].tap()
        let editor = app.textViews["Text to paste"]; XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap(); editor.typeText("printf 'NUM_%s_OK\\n' ")
        app.buttons["Insert"].tap()
        app.buttons["Session actions"].tap(); tap("Number keys", in: app)
        XCTAssertTrue(app.buttons["7"].waitForExistence(timeout: 5))
        let keyRows = ["1", "4", "7", ".", "Delete"].map { app.buttons[$0] }
        for key in keyRows { XCTAssertGreaterThanOrEqual(key.frame.height, 44); XCTAssertTrue(key.isHittable) }
        for index in 1..<keyRows.count { XCTAssertLessThanOrEqual(keyRows[index - 1].frame.maxY, keyRows[index].frame.minY) }
        XCTAssertTrue(app.buttons["number-enter"].isHittable); capture("number-keys")
        app.buttons["7"].tap(); app.buttons["number-enter"].tap(); app.buttons["Done"].tap()
        XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "NUM_7_OK")).firstMatch.waitForExistence(timeout: 5))
    }
    func testLoadedMediaDocumentAndLink() {
        let app = app(); app.buttons["Library"].tap()
        let history = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Conversation history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10)); history.tap()
        let search = app.searchFields["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5)); replace(search, "parity-saved-transcript"); search.typeText("\n")
        tap("Media and links", in: app)
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "image/png")).firstMatch.waitForExistence(timeout: 15))
        capture("media-loaded")
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "image/png")).firstMatch.tap()
        XCTAssertTrue(app.images["Session image"].waitForExistence(timeout: 10)); capture("media-image")
        app.images["Session image"].pinch(withScale: 2, velocity: 1)
        XCTAssertGreaterThan(app.images["Session image"].frame.width, app.windows.firstMatch.frame.width)
        app.buttons["Next"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Native document fixture"].waitForExistence(timeout: 10)); capture("media-document")
        app.buttons["Next"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 5)); capture("media-link")
        app.buttons["Previous"].tap(); XCTAssertTrue(app.webViews.staticTexts["Native document fixture"].waitForExistence(timeout: 10))
        app.buttons["Done"].tap()
        tap("gbasin/agentboard #1", in: app)
        XCTAssertTrue(app.navigationBars["Pull request"].waitForExistence(timeout: 5))
        capture("pull-request")
        reveal(app.buttons["Open pull request"], in: app)
    }
    func testPhotoUploadAndInsertIntoShell() {
        let app = app()
        openSession("native-live-one", in: app)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        app.buttons["Session actions"].tap(); tap("Attach file", in: app)
        app.buttons["Choose photo"].tap()
        sleep(2)
        let notice = app.otherElements["PXGSingleViewContainerView_AX"]
        if notice.buttons["Close"].firstMatch.exists { notice.buttons["Close"].firstMatch.tap() }
        capture("photo-picker")
        let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 5)); photo.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        // PhotosUI exposes its checkmark as identifier Add / label Done. Its remote
        // sheet may report isHittable=false despite a valid visible accessibility frame.
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 3), app.debugDescription)
        add.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Insert file path"].waitForExistence(timeout: 15)); capture("uploaded-photo")
        app.buttons["Insert file path"].tap()
        XCTAssertTrue(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.webViews.staticTexts.allElementsBoundByIndex.map(\.label).joined().contains("/tmp/paste-") }, object: nil)], timeout: 10) == .completed)
        // Clear the unexecuted path; insertion must not execute a command.
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.65)).tap(); app.buttons["Control"].tap(); app.typeText("u")
    }

    func testFilePickerUploadAndInsert() {
        let app = app()
        openSession("native-live-one", in: app)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        app.buttons["Session actions"].tap(); tap("Attach file", in: app)
        app.buttons["Choose file"].tap()
        XCTAssertTrue(app.buttons["Browse"].waitForExistence(timeout: 5)); app.buttons["Browse"].tap()
        if app.buttons["Browse"].exists { app.buttons["Browse"].tap() }
        let location = app.staticTexts["On My iPhone"]
        XCTAssertTrue(location.waitForExistence(timeout: 5)); location.tap()
        app.cells["Agentboard, Container"].images.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        sleep(1)
        let file = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "parity-upload")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 5)); app.cells["parity-upload, txt"].images.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        let open = app.buttons["Open"]
        if open.waitForExistence(timeout: 3) { open.tap() }
        XCTAssertTrue(app.buttons["Insert file path"].waitForExistence(timeout: 15)); capture("uploaded-file")
        app.buttons["Insert file path"].tap()
        XCTAssertTrue(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.webViews.staticTexts.allElementsBoundByIndex.map(\.label).joined().contains("parity-upload.txt") }, object: nil)], timeout: 10) == .completed)
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.65)).tap(); app.buttons["Control"].tap(); app.typeText("u")
    }

    func testCatalogSearchAndPreferencePersistence() {
        let app = app(); capture("catalog")
        let search = app.searchFields["Find a session"]
        replace(search, "no-session-with-this-name"); search.typeText("\n")
        XCTAssertTrue(app.staticTexts["No matching sessions"].waitForExistence(timeout: 5))
        app.buttons["Clear search and filters"].tap()
        XCTAssertFalse(app.staticTexts["No matching sessions"].exists)
        app.buttons["Settings"].tap()
        let settingsSearch = app.searchFields["Find a setting"]
        replace(settingsSearch, "Session ID prefix"); settingsSearch.typeText("\n")
        let toggle = app.switches["Session ID prefix"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let before = toggle.value as? String
        toggle.coordinate(withNormalizedOffset: .init(dx: 0.9, dy: 0.5)).tap(); sleep(1)
        XCTAssertNotEqual(toggle.value as? String, before)
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
        if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        else { app.buttons["Close"].firstMatch.tap() }
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 15))
        app.buttons["Settings"].tap()
        replace(app.searchFields["Find a setting"], "Session ID prefix"); app.searchFields["Find a setting"].typeText("\n")
        XCTAssertNotEqual(app.switches["Session ID prefix"].value as? String, before)
        app.switches["Session ID prefix"].coordinate(withNormalizedOffset: .init(dx: 0.9, dy: 0.5)).tap(); capture("settings-search")
    }

    func testPullRequestCheckStatesWithGitHubFixture() {
        let app = app(server: "http://127.0.0.1:4190")
        app.buttons["Library"].tap()
        let history = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Conversation history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10)); history.tap()
        let search = app.searchFields["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5)); replace(search, "parity-saved-transcript"); search.typeText("\n")
        tap("Media and links", in: app); tap("gbasin/agentboard #1", in: app)
        XCTAssertTrue(app.staticTexts["Parity pull request fixture"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["OPEN · Draft · fixture-author"].exists)
        capture("pull-request-checks")
        for status in ["Passed", "In progress", "Failed"] {
            reveal(app.staticTexts[status], in: app)
            XCTAssertTrue(app.buttons.matching(identifier: "Open check").firstMatch.exists)
        }
        capture("pull-request-checks-bottom")
    }

}
