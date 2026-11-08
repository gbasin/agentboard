import SwiftUI

/// Counts the available catalog snapshot, which older servers may truncate.
/// These are deliberately not advertised as authoritative transcript totals.
struct NativeMediaSummary: Equatable {
    let images: Int
    let links: Int
    let files: Int
    init(items: [MediaItem]) {
        images = items.filter { $0.kind == "image" }.count
        links = items.filter { $0.kind == "link" }.count
        files = items.filter { $0.kind != "image" && $0.kind != "link" }.count
    }
    var total: Int { images + links + files }
    var accessibilityDescription: String {
        "Available media: \(images) images, \(links) links, \(files) files"
    }
}

struct NativeMediaSummaryButton: View {
    let summary: NativeMediaSummary
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    Text("Available")
                    Label("\(summary.images)", systemImage: "photo")
                    Label("\(summary.links)", systemImage: "link")
                    Label("\(summary.files)", systemImage: "doc")
                }
                Label("\(summary.total) available", systemImage: "photo.on.rectangle")
            }
            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            .padding(.horizontal, 14).frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .nativeGlassSurface(cornerRadius: 22, interactive: true)
        .accessibilityIdentifier("available-media")
        .accessibilityLabel(summary.accessibilityDescription)
        .accessibilityHint("Opens media and links available from the server")
    }
}
