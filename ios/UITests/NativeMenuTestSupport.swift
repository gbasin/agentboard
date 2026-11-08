import XCTest

/// Native context menus report a scrolling frame larger than their visible popup.
extension XCUIApplication {
    func tapNativeMenuAction(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            let button = self.buttons[title]
            // UIKit can show the menu's loading placeholder before exposing its
            // collection. Reading a missing element's frame fails XCTest early.
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0,
                  self.collectionViews.firstMatch.waitForExistence(timeout: remaining),
                  let menu = self.collectionViews.allElementsBoundByIndex.last,
                  menu.exists else { break }
            let snapshot: XCUIElementSnapshot
            do { snapshot = try menu.snapshot() } catch { break }
            let menuFrame = snapshot.frame
            // UIKit's collection frame exceeds the clipped popup; its enclosing
            // accessibility views expose the actual visible rectangle.
            let enclosing = self.otherElements.containing(NSPredicate(format: "elementType == %d", XCUIElement.ElementType.collectionView.rawValue))
                .allElementsBoundByIndex.map(\.frame).filter {
                    abs($0.minX - menuFrame.minX) < 1 && abs($0.width - menuFrame.width) < 1 && $0.height > 0
                }.min { $0.height < $1.height }
            let viewport = (enclosing ?? menuFrame).intersection(self.frame).insetBy(dx: 8, dy: 8)
            if button.exists && button.isHittable {
                let center = CGPoint(x: button.frame.midX, y: button.frame.midY)
                if viewport.contains(center) {
                    // Native menu accessibility can change Button → PopUpButton while XCTest
                    // auto-scrolls a tap. Tap its verified visible center without auto-scrolling.
                    button.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: 0.5)).tap(); return
                }
            }
            let above = button.exists && button.frame.midY < viewport.minY
            guard viewport.width > 0, viewport.height > 0 else { break }
            // Start on an enabled outer action. Fixed viewport fractions can
            // land in the tall disabled connection row or the Appearance picker.
            let pickerLabels: Set<String> = ["Appearance", "System", "Light", "Dark"]
            // Read attributes from one public snapshot instead of requesting
            // separate accessibility snapshots for every button attribute.
            func actionCenters(_ element: XCUIElementSnapshot) -> [CGPoint] {
                var centers: [CGPoint] = []
                if element.elementType == .button && element.isEnabled && !pickerLabels.contains(element.label) {
                    let center = CGPoint(x: element.frame.midX, y: element.frame.midY)
                    if viewport.contains(center) { centers.append(center) }
                }
                for child in element.children { centers.append(contentsOf: actionCenters(child)) }
                return centers
            }
            let centers = actionCenters(snapshot)
            guard let start = centers.sorted(by: { above ? $0.y < $1.y : $0.y > $1.y }).first else { break }
            let origin = self.coordinate(withNormalizedOffset: .zero)
            let from = origin.withOffset(.init(dx: start.x - self.frame.minX, dy: start.y - self.frame.minY))
            let to = origin.withOffset(.init(dx: start.x - self.frame.minX, dy: (above ? viewport.maxY : viewport.minY) - self.frame.minY))
            // A single gesture can spend time waiting for UIKit to become idle.
            // Check elapsed time between gestures instead of multiplying that wait.
            guard Date() < deadline else { break }
            from.press(forDuration: 0.05, thenDragTo: to)
        }
        attachNavigationFailure("menu-" + title)
        XCTFail("Menu action is unreachable: \(title)", file: file, line: line)
    }

    func tapVisibleConfirmation(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = self.buttons[identifier]
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
