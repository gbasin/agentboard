import XCTest

/// Native context menus report a scrolling frame larger than their visible popup.
extension XCUIApplication {
    func tapNativeMenuAction(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(120)
        // Popup bounds stay fixed while its virtualized content scrolls. Read
        // them once so each pan does not repeat accessibility geometry queries.
        let appFrame = self.frame
        var popup: (collection: XCUIElement, frame: CGRect)?
        func actions(in node: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            var matches = node.children.flatMap { actions(in: $0) }
            if matches.isEmpty && (node.elementType == .button || node.elementType == .popUpButton),
               (node.label == title || node.identifier == title) { matches.append(node) }
            return matches
        }
        func center(of node: XCUIElementSnapshot) -> CGPoint? {
            let frame = node.frame
            guard frame.minX.isFinite, frame.minY.isFinite, frame.width.isFinite, frame.height.isFinite,
                  frame.width > 0, frame.height > 0 else { return nil }
            let point = CGPoint(x: frame.midX, y: frame.midY)
            return point.x.isFinite && point.y.isFinite ? point : nil
        }
        while Date() < deadline {
            if popup == nil {
                let remaining = deadline.timeIntervalSinceNow
                guard remaining > 0,
                      self.collectionViews.firstMatch.waitForExistence(timeout: remaining),
                      let menu = self.collectionViews.allElementsBoundByIndex.last else { break }
                let menuFrame = menu.frame
                guard menuFrame.minX.isFinite, menuFrame.minY.isFinite, menuFrame.width > 0, menuFrame.height > 0 else { break }
                // The collection extends below the clipped popup. Cache each
                // enclosing frame once, then choose the smallest visible bound.
                let enclosing = self.otherElements.containing(NSPredicate(format: "elementType == %d", XCUIElement.ElementType.collectionView.rawValue))
                    .allElementsBoundByIndex.map { $0.frame }.filter {
                        abs($0.minX - menuFrame.minX) < 1 && abs($0.width - menuFrame.width) < 1 && $0.height > 0
                    }.min { $0.height < $1.height }
                popup = (menu, (enclosing ?? menuFrame).intersection(appFrame))
            }
            guard let popup, popup.frame.width > 0, popup.frame.height > 0 else { break }
            let viewport = popup.frame.insetBy(dx: 8, dy: 8)
            guard viewport.width > 0, viewport.height > 0 else { break }
            let snapshot: XCUIElementSnapshot
            do { snapshot = try popup.collection.snapshot() } catch { break }
            // A virtualized action can disappear between live attribute reads.
            // One snapshot keeps its type, enabled state, and geometry together.
            // This front menu's clipped bounds provide the visibility check.
            let matches = actions(in: snapshot)
            func visiblePoint(of node: XCUIElementSnapshot) -> CGPoint? {
                guard center(of: node) != nil else { return nil }
                // A large row can be usable while its full center is clipped.
                // Require a normal touch target, not a thin edge fragment.
                let visible = node.frame.intersection(viewport)
                guard !visible.isNull, visible.width >= min(44, node.frame.width),
                      visible.height >= min(44, node.frame.height) else { return nil }
                return CGPoint(x: visible.midX, y: visible.midY)
            }
            if let point = matches.lazy.filter(\.isEnabled).compactMap({ visiblePoint(of: $0) }).first {
                // An element tap can auto-scroll and re-resolve the menu node.
                self.coordinate(withNormalizedOffset: .zero)
                    .withOffset(.init(dx: point.x - appFrame.minX, dy: point.y - appFrame.minY)).tap()
                return
            }
            let above = matches.compactMap({ center(of: $0) }).first.map { $0.y < viewport.minY } ?? false
            let startY = above ? viewport.minY + viewport.height * 0.2 : viewport.maxY - viewport.height * 0.2
            let endY = startY + viewport.height * (above ? 0.45 : -0.45)
            let origin = self.coordinate(withNormalizedOffset: .zero)
            let from = origin.withOffset(.init(dx: viewport.midX - appFrame.minX, dy: startY - appFrame.minY))
            let to = origin.withOffset(.init(dx: viewport.midX - appFrame.minX, dy: endY - appFrame.minY))
            // Fast travel wins the menu's pan recognizer. The endpoint hold
            // prevents release from flinging past a virtualized action.
            from.press(forDuration: 0, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: 1000), thenHoldForDuration: 0.2)
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
