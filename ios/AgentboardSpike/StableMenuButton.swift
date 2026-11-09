import SwiftUI
import UIKit

/// Resolve native menu content once per opening. Updating the provider must not
/// replace UIButton.menu: UIKit would rebuild the visible popup and lose its pan.
struct StableMenuButton: UIViewRepresentable {
    let makeItems: () -> [UIMenuElement]

    func makeUIView(context: Context) -> Button { Button(makeItems: makeItems) }
    func updateUIView(_ button: Button, context: Context) { button.makeItems = makeItems }

    final class Button: UIButton {
        var makeItems: () -> [UIMenuElement]

        init(makeItems: @escaping () -> [UIMenuElement]) {
            self.makeItems = makeItems
            super.init(frame: .zero)
            setImage(UIImage(systemName: "ellipsis"), for: .normal)
            setPreferredSymbolConfiguration(.init(textStyle: .body), forImageIn: .normal)
            accessibilityLabel = "Session actions"
            showsMenuAsPrimaryAction = true
            menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
                completion(self?.makeItems() ?? [])
            }])
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override var intrinsicContentSize: CGSize { CGSize(width: 44, height: 44) }
    }
}
