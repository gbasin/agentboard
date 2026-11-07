import SwiftUI

/// Keeps editable values identifiable after their placeholder disappears.
struct FormField<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.primary).accessibilityHidden(true)
            content()
        }.padding(.vertical, 2)
    }
}
