import XCTest

/// Runs every native destination against the private backend seeded by seed-parity.ts.
final class NativeParityUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false; XCUIDevice.shared.orientation = .portrait }
    override func tearDown() {
        if (testRun?.failureCount ?? 0) > 0 {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "parity-failure"; screenshot.lifetime = .keepAlways; add(screenshot)
            let hierarchy = XCTAttachment(string: XCUIApplication().debugDescription)
            hierarchy.name = "parity-failure-hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
        }
        super.tearDown()
    }
    private func app(server: String = "http://127.0.0.1:4151") -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["-serverURL", server]; app.launch()
        XCTAssertTrue(app.waitForBoardConnection(timeout: 15)); return app
    }
    private func capture(_ name: String) {
        sleep(1); let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "parity-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func replace(_ field: XCUIElement, _ value: String) {
        if field.elementType == .searchField {
            field.tap(); sleep(1)
            if field.buttons["Clear text"].exists { field.buttons["Clear text"].tap() }
            XCTAssertTrue((field.value as? String ?? "") == "" || (field.value as? String) == field.placeholderValue)
            field.typeText(value); return
        }
        field.replaceNativeText(with: value, in: XCUIApplication())
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, preferUp: Bool = false, refreshMedia: Bool = false) {
        for _ in 0..<20 {
            // Discovery retains the visible snapshot. Follow the explicit refresh
            // action before looking for newly discovered documents in that page.
            let refresh = app.buttons["refresh-changed-media"]
            if refreshMedia && refresh.exists {
                reveal(refresh, in: app, preferUp: true)
                refresh.tap()
                let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: refresh)
                XCTAssertEqual(XCTWaiter.wait(for: [refreshed], timeout: 15), .completed)
                continue
            }
            let top = app.navigationBars.allElementsBoundByIndex.last?.frame.maxY ?? app.frame.minY
            var bottom = app.frame.maxY - 20
            if app.keyboards.firstMatch.exists { bottom = min(bottom, app.keyboards.firstMatch.frame.minY) }
            if let search = app.searchFields.allElementsBoundByIndex.last, search.frame.midY > app.frame.midY { bottom = min(bottom, search.frame.minY) }
            if element.exists && element.isHittable && element.frame.minY >= top && element.frame.maxY < bottom { return }
            // A sheet's collection center can be behind the keyboard, making the collection
            // itself non-hittable even though its visible rows can scroll. Use the front list.
            let list = app.collectionViews.allElementsBoundByIndex.last ?? app.collectionViews.firstMatch
            let frame = list.frame
            let visibleTop = max(top, frame.minY) + 12
            let visibleBottom = min(bottom, frame.maxY) - 12
            guard frame.height > 0, visibleBottom > visibleTop else { XCTFail("No visible scroll area"); return }
            let lower = (visibleTop + (visibleBottom - visibleTop) * 0.75 - frame.minY) / frame.height
            let upper = (visibleTop + (visibleBottom - visibleTop) * 0.25 - frame.minY) / frame.height
            let down = (element.exists && element.frame.minY < top) || (!element.exists && preferUp)
            list.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: down ? upper : lower))
                .press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: down ? lower : upper)))
        }
        if !element.exists || !element.isHittable {
            capture("unreachable-control")
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "unreachable-control-hierarchy"; tree.lifetime = .keepAlways; add(tree)
        }
        XCTAssertTrue(element.exists, "Missing \(element) after scrolling")
        XCTAssertTrue(element.isHittable, "Unreachable \(element) after scrolling")
    }
    private func tap(_ title: String, in app: XCUIApplication, preferUp: Bool = false) {
        let button = app.buttons[title]; reveal(button, in: app, preferUp: preferUp); button.tap()
    }
    private func tapMenu(_ title: String, in app: XCUIApplication) {
        app.tapNativeMenuAction(title)
    }

    private func dismissPreview(_ title: String, in app: XCUIApplication) {
        let preview = app.navigationBars[title]
        preview.buttons["Done"].tap()
        // Quick Look can outlive the tap while its remote accessibility tree closes.
        // Do not capture indexed navigation bars until the preview has disappeared.
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: preview)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 15), .completed)
    }

    private func search(_ value: String, in app: XCUIApplication) {
        let search = app.searchFields["Search saved sessions"]; XCTAssertTrue(search.waitForExistence(timeout: 5)); replace(search, value); search.typeText("\n")
    }
    private func openSession(_ name: String, in app: XCUIApplication) {
        let field = app.searchFields["Find a session"]
        replace(field, name); field.typeText("\n")
        let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        reveal(row, in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10)); XCTAssertTrue(row.isHittable); row.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["Enter"])
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed, app.debugDescription)
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
        XCTAssertTrue(app.waitForTerminalInput(timeout: 20))
        app.buttons["Session actions"].tap(); tapMenu("Duplicate session", in: app)
        XCTAssertTrue(app.textFields["session-command"].waitForExistence(timeout: 5))
        XCTAssertTrue((app.textFields["session-project"].value as? String ?? "").hasSuffix("/tmp/ab-ios-parity/project"))
        app.buttons["Cancel"].tap()
        app.buttons["Session actions"].tap(); tapMenu("Hibernate session", in: app)
        app.tapVisibleConfirmation("confirm-end-session")
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
        XCTAssertTrue(app.buttons["Resume session"].waitForExistence(timeout: 5))
        capture("saved-detail-top")
        XCTAssertFalse(app.buttons["Archive session"].exists, "Archived sessions must not offer Archive again")
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
        app.buttons["Session actions"].tap(); tapMenu("Media and links", in: app)
        XCTAssertTrue(app.navigationBars["Media and links"].waitForExistence(timeout: 5)); capture("media-empty"); app.buttons["Done"].tap()
        app.buttons["Session actions"].tap(); tapMenu("Attach file", in: app)
        XCTAssertTrue(app.buttons["Choose file"].waitForExistence(timeout: 5)); capture("attach-file")
        app.buttons["Choose file"].tap()
        let filePicker = app.navigationBars["FullDocumentManagerViewControllerNavigationBar"]
        XCTAssertTrue(filePicker.waitForExistence(timeout: 30))
        filePicker.buttons["Cancel"].tap()
        XCTAssertTrue(filePicker.waitForNonExistence(timeout: 10))
        app.navigationBars["Attach to session"].buttons["Cancel"].tap()
        app.tapTerminalKey("Paste text")
        let editor = app.textViews["Text to paste"]; XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap(); editor.typeText("printf 'NUM_%s_OK\\n' ")
        app.buttons["Insert"].tap()
        app.buttons["Session actions"].tap(); tapMenu("Number keys", in: app)
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
        app.segmentedControls["library-category"].buttons["History"].tap()
        let history = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Conversation history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10)); reveal(history, in: app); history.tap()
        let search = app.searchFields["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5)); replace(search, "parity-saved-transcript"); search.typeText("\n")
        tap("Media and links", in: app)
        XCTAssertTrue(app.navigationBars["Media and links"].waitForExistence(timeout: 15))
        // List rows below the viewport may not enter the accessibility tree until scrolled.
        let image = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "image/png")).firstMatch
        reveal(image, in: app, refreshMedia: true); capture("media-loaded"); image.tap()
        XCTAssertTrue(app.images["Session image"].waitForExistence(timeout: 10)); capture("media-image")
        app.images["Session image"].pinch(withScale: 2, velocity: 1)
        XCTAssertGreaterThan(app.images["Session image"].frame.width, app.windows.firstMatch.frame.width)
        dismissPreview("Media", in: app)
        let document = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "text/html")).firstMatch
        reveal(document, in: app, refreshMedia: true); document.tap()
        XCTAssertTrue(app.buttons["Share document"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["HTML source"].waitForExistence(timeout: 10))
        capture("media-document")
        dismissPreview("Media", in: app)
        let pdf = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "application/pdf")).firstMatch
        reveal(pdf, in: app, refreshMedia: true); pdf.tap()
        XCTAssertTrue(app.buttons["Share document"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.otherElements["document-preview"].waitForExistence(timeout: 10))
        capture("media-pdf")
        dismissPreview("Media", in: app)
        tap("Native link fixture", in: app)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 5)); capture("media-link")
        dismissPreview("Native link fixture", in: app)
        tap("gbasin/agentboard #1", in: app, preferUp: true)
        XCTAssertTrue(app.navigationBars["Pull request"].waitForExistence(timeout: 5))
        capture("pull-request")
        reveal(app.links["Open pull request"], in: app)
    }
    func testPhotoUploadAndInsertIntoShell() {
        let app = app()
        openSession("native-live-one", in: app)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        app.buttons["Session actions"].tap(); tapMenu("Attach file", in: app)
        chooseFirstPhoto(in: app)
        XCTAssertTrue(app.buttons["confirm-attachments"].waitForExistence(timeout: 10))
        // A fresh picker selection must append only the explicit new selection,
        // rather than re-appending the previous picker selection as well.
        chooseFirstPhoto(in: app)
        let second = app.buttons["remove-attachment-1"]
        XCTAssertTrue(second.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["remove-attachment-2"].exists)
        capture("two-photo-review")
        second.tap()
        XCTAssertTrue(app.buttons["confirm-attachments"].waitForExistence(timeout: 10))
        capture("attachment-review")
        app.buttons["confirm-attachments"].tap()
        XCTAssertTrue(app.navigationBars["Attach to session"].waitForNonExistence(timeout: 15)); capture("inserted-photo")
        XCTAssertTrue(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.webViews.staticTexts.allElementsBoundByIndex.map(\.label).joined().contains("/tmp/paste-") }, object: nil)], timeout: 10) == .completed)
        // Clear the unexecuted path; insertion must not execute a command.
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.65)).tap(); app.tapTerminalKey("Control"); app.typeText("u")
    }

    private func chooseFirstPhoto(in app: XCUIApplication) {
        tap("Choose photo", in: app)
        let notice = app.otherElements["PXGSingleViewContainerView_AX"].firstMatch
        let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            notice.buttons["Close"].firstMatch.exists || photo.exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [loaded], timeout: 30), .completed)
        if notice.buttons["Close"].firstMatch.exists { notice.buttons["Close"].firstMatch.tap() }
        XCTAssertTrue(photo.waitForExistence(timeout: 20)); capture("photo-picker")
        photo.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        // PhotosUI exposes its checkmark as identifier Add / label Done. Its remote
        // sheet may report isHittable=false despite a valid visible accessibility frame.
        let add = app.buttons["Add"]
        XCTAssertTrue(add.waitForExistence(timeout: 3), app.debugDescription)
        add.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
    }

    func testFilePickerUploadAndInsert() {
        let app = app()
        openSession("native-live-one", in: app)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10))
        app.buttons["Session actions"].tap(); tapMenu("Attach file", in: app)
        app.buttons["Choose file"].tap()
        // Files can reopen the last folder. Do not navigate away from an already visible fixture.
        let picker = app.navigationBars["FullDocumentManagerViewControllerNavigationBar"]
        XCTAssertTrue(picker.waitForExistence(timeout: 30))
        let file = app.cells["parity-upload, txt"]
        if !file.waitForExistence(timeout: 3) {
            let browse = app.buttons["Browse"].firstMatch
            XCTAssertTrue(browse.waitForExistence(timeout: 15)); browse.tap()
            if !file.waitForExistence(timeout: 3) {
                let location = app.staticTexts["On My iPhone"]
                if !location.exists { browse.tap() }
                XCTAssertTrue(location.waitForExistence(timeout: 10)); location.tap()
                let folder = app.cells["Agentboard, Container"]
                XCTAssertTrue(folder.waitForExistence(timeout: 10))
                folder.images.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
            }
        }
        XCTAssertTrue(file.waitForExistence(timeout: 10))
        file.images.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap()
        let open = app.buttons["Open"]
        if open.waitForExistence(timeout: 3) {
            // Files exposes Open before the selected provider item is ready.
            // Wait for its action to enable rather than tapping its disabled state.
            let confirmation = app.buttons["confirm-attachments"]
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                confirmation.exists || (open.exists && open.isEnabled && open.isHittable)
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
            if !confirmation.exists { open.tap() }
        }
        // Accepting Open starts system-provider work before our importer callback.
        // Keep picker completion separate from the app's attachment-review budget.
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: picker)
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 30), .completed, "Files picker did not dismiss after selection.\n" + app.debugDescription)
        XCTAssertTrue(app.buttons["confirm-attachments"].waitForExistence(timeout: 10))
        capture("attachment-review")
        app.buttons["confirm-attachments"].tap()
        XCTAssertTrue(app.navigationBars["Attach to session"].waitForNonExistence(timeout: 15)); capture("inserted-file")
        XCTAssertTrue(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.webViews.staticTexts.allElementsBoundByIndex.map(\.label).joined().contains("parity-upload.txt") }, object: nil)], timeout: 10) == .completed)
        app.webViews.firstMatch.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.65)).tap(); app.tapTerminalKey("Control"); app.typeText("u")
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
        XCTAssertTrue(app.waitForBoardConnection(timeout: 15))
        app.buttons["Settings"].tap()
        replace(app.searchFields["Find a setting"], "Session ID prefix"); app.searchFields["Find a setting"].typeText("\n")
        XCTAssertNotEqual(app.switches["Session ID prefix"].value as? String, before)
        app.switches["Session ID prefix"].coordinate(withNormalizedOffset: .init(dx: 0.9, dy: 0.5)).tap(); capture("settings-search")
    }

    func testPullRequestCheckStatesWithGitHubFixture() {
        let app = app(server: "http://127.0.0.1:4190")
        app.buttons["Library"].tap()
        app.segmentedControls["library-category"].buttons["History"].tap()
        let history = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Conversation history")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10)); reveal(history, in: app); history.tap()
        let search = app.searchFields["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5)); replace(search, "parity-saved-transcript"); search.typeText("\n")
        tap("Media and links", in: app); tap("gbasin/agentboard #1", in: app, preferUp: true)
        XCTAssertTrue(app.staticTexts["Parity pull request fixture"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["OPEN · Draft · fixture-author"].exists)
        capture("pull-request-checks")
        for status in ["Passed", "In progress", "Failed"] {
            reveal(app.staticTexts[status], in: app)
            XCTAssertTrue(app.links.matching(identifier: "Open check").firstMatch.exists)
        }
        capture("pull-request-checks-bottom")
    }

    func testNativeDevicePreferencesPersist() {
        let app = app()
        for title in ["Keyboard autocorrect", "Session status overview"] {
            app.buttons["Settings"].tap()
            let search = app.searchFields["Find a setting"]
            XCTAssertTrue(search.waitForExistence(timeout: 5))
            replace(search, title); search.typeText("\n")
            let setting = app.switches[title]
            XCTAssertTrue(setting.waitForExistence(timeout: 5))
            let before = setting.value as? String
            setting.coordinate(withNormalizedOffset: .init(dx: 0.9, dy: 0.5)).tap()
            XCTAssertNotEqual(setting.value as? String, before)
            if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
            if !app.buttons["Done"].exists { app.buttons["Close"].firstMatch.tap() }
            if app.buttons["Done"].exists { app.buttons["Done"].tap() }
            app.buttons["Settings"].tap()
            XCTAssertTrue(search.waitForExistence(timeout: 5))
            replace(search, title); search.typeText("\n")
            XCTAssertNotEqual(setting.value as? String, before)
            setting.coordinate(withNormalizedOffset: .init(dx: 0.9, dy: 0.5)).tap()
            XCTAssertEqual(setting.value as? String, before)
            capture(title == "Keyboard autocorrect" ? "autocorrect-setting" : "overview-setting")
            if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
            if !app.buttons["Done"].exists { app.buttons["Close"].firstMatch.tap() }
            if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        }
    }

}
