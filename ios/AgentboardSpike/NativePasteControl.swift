import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The system Paste control authorizes clipboard access and supplies item providers asynchronously.
struct NativePasteControl: UIViewRepresentable {
    let controller: NativePasteController
    let accepted: () -> Void
    func makeCoordinator() -> Receiver { Receiver(controller: controller, accepted: accepted) }
    func makeUIView(context: Context) -> UIPasteControl {
        let configuration = UIPasteControl.Configuration()
        configuration.displayMode = .iconAndLabel
        let control = UIPasteControl(configuration: configuration)
        control.target = context.coordinator
        control.accessibilityIdentifier = "Paste from clipboard"
        control.accessibilityLabel = "Paste from clipboard"
        return control
    }
    func updateUIView(_ control: UIPasteControl, context: Context) {
        context.coordinator.accepted = accepted
    }
    final class Receiver: NSObject, UIPasteConfigurationSupporting {
        var pasteConfiguration: UIPasteConfiguration? = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.item.identifier])
        let controller: NativePasteController
        var accepted: () -> Void
        init(controller: NativePasteController, accepted: @escaping () -> Void) {
            self.controller = controller; self.accepted = accepted
        }
        func paste(itemProviders: [NSItemProvider]) {
            controller.submit(itemProviders: itemProviders)
            accepted()
        }
        func canPaste(_ itemProviders: [NSItemProvider]) -> Bool { !itemProviders.isEmpty }
    }
}
