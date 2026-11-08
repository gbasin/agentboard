import XCTest

/// Native context menus report a scrolling frame larger than their visible popup.
extension XCUIApplication {
    func tapNativeMenuAction(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<20 {
            let button = self.buttons[title]
            let menu = self.collectionViews.allElementsBoundByIndex.last ?? self.collectionViews.firstMatch
            let menuFrame = menu.frame
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
                    // Anchor to the app: a button-relative coordinate re-queries the
                    // disappearing menu element during touch synthesis on iOS 26.5.
                    self.coordinate(withNormalizedOffset: .zero)
                        .withOffset(CGVector(dx: center.x - self.frame.minX, dy: center.y - self.frame.minY)).tap()
                    return
                }
            }
            let above = button.exists && button.frame.midY < viewport.minY
            menu.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: above ? 0.10 : 0.25))
                .press(forDuration: 0.05, thenDragTo: menu.coordinate(withNormalizedOffset: .init(dx: 0.5, dy: above ? 0.25 : 0.10)))
        }
        XCTFail("Menu action is unreachable: \(title)", file: file, line: line)
    }
}
