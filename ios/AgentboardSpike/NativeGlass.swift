import SwiftUI

/// Shared native material with an opaque accessibility alternative.
private struct NativeGlassSurface: ViewModifier {
    let cornerRadius: CGFloat
    let interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(uiColor: .secondarySystemGroupedBackground),
                               in: RoundedRectangle(cornerRadius: cornerRadius))
        } else if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(interactive), in: .rect(cornerRadius: cornerRadius))
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
        }
    }
}

extension View {
    func nativeGlassSurface(cornerRadius: CGFloat = 18, interactive: Bool = false) -> some View {
        modifier(NativeGlassSurface(cornerRadius: cornerRadius, interactive: interactive))
    }
}
