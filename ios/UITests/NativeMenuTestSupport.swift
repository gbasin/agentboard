import XCTest

/// Native context menus report a scrolling frame larger than their visible popup.
extension XCUIApplication {
    func tapNativeMenuAction(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            // UIKit changes menu actions between Button and PopUpButton while
            // scrolling. Keep the query independent of that transient type.
            let button = self.descendants(matching: .any).matching(NSPredicate(
                format: "(label == %@ OR identifier == %@) AND (elementType == %d OR elementType == %d)",
                title, title, XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.popUpButton.rawValue
            )).firstMatch
            if button.exists && button.isHittable { button.tap(); return }
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0,
                  self.collectionViews.firstMatch.waitForExistence(timeout: remaining),
                  let menu = self.collectionViews.allElementsBoundByIndex.last else { break }
            let menuFrame = menu.frame
            guard menuFrame.minX.isFinite, menuFrame.minY.isFinite, menuFrame.width > 0, menuFrame.height > 0 else { break }
            // The collection's accessibility frame extends below the popup.
            // Swipe its visible enclosing view so XCTest places a native swipe
            // inside the menu, rather than dragging a menu action.
            let enclosing = self.otherElements.containing(NSPredicate(format: "elementType == %d", XCUIElement.ElementType.collectionView.rawValue))
                .allElementsBoundByIndex.filter {
                    let frame = $0.frame
                    return abs(frame.minX - menuFrame.minX) < 1 && abs(frame.width - menuFrame.width) < 1 && frame.height > 0
                }.min { $0.frame.height < $1.frame.height }
            let scroller = enclosing ?? menu
            if button.exists && button.frame.midY < scroller.frame.minY { scroller.swipeDown(velocity: .fast) }
            else { scroller.swipeUp(velocity: .fast) }
        }
        attachNavigationFailure("menu-" + title)
        XCTFail("Menu action is unreachable: \(title)", file: file, line: line)
    }

    func tapVisibleConfirmation(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = self.buttons[identifier]
        guard button.waitForExistence(timeout: 15) else {
            attachNavigationFailure("confirmation-" + identifier)
            XCTFail("Confirmation did not appear: \(identifier)", file: file, line: line)
            return
        }
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            let top = self.navigationBars.allElementsBoundByIndex.last?.frame.maxY ?? self.frame.minY
            let bottom = self.keyboards.firstMatch.exists ? self.keyboards.firstMatch.frame.minY : self.frame.maxY - 20
            if button.exists && button.isHittable && button.frame.minY >= top && button.frame.maxY < bottom {
                button.tap(); return
            }
            let list = self.collectionViews.allElementsBoundByIndex.last ?? self.collectionViews.firstMatch
            guard list.exists, list.frame.height > 0 else { break }
            let frame = list.frame
            let upper = max(top, frame.minY) + 12
            let lower = min(bottom, frame.maxY) - 12
            guard lower > upper else { break }
            list.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: (upper + (lower - upper) * 0.75 - frame.minY) / frame.height))
                .press(forDuration: 0.05, thenDragTo: list.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: (upper + (lower - upper) * 0.25 - frame.minY) / frame.height)))
        }
        attachNavigationFailure("confirmation-" + identifier)
        XCTFail("Confirmation is unreachable: \(identifier)", file: file, line: line)
    }
    private func attachNavigationFailure(_ name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways
        let hierarchy = XCTAttachment(string: self.debugDescription)
        hierarchy.name = name + "-hierarchy"; hierarchy.lifetime = .keepAlways
        XCTContext.runActivity(named: name) { activity in activity.add(screenshot); activity.add(hierarchy) }
    }
}
