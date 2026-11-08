import SwiftUI

/// Uses indexed totals when supplied; legacy snapshots remain explicitly labeled as available media.
struct NativeMediaSummary: Equatable {
    let images: Int
    let links: Int
    let files: Int
    var catalog: MediaCatalogSummary? = nil
    init(items: [MediaItem]) {
        images = items.filter { $0.kind == "image" }.count
        links = items.filter { $0.kind == "link" }.count
        files = items.filter { $0.kind != "image" && $0.kind != "link" }.count
    }
    init(catalog: MediaCatalogSummary) {
        images = catalog.images; links = catalog.links
        files = catalog.documents + (catalog.previews ?? 0); self.catalog = catalog
    }
    var total: Int { catalog?.total ?? images + links + files }
    var caption: String { catalog?.discovery?.running == true ? "Discovering" : catalog == nil ? "Available" : "Media" }
    var canBrowse: Bool { total > 0 || catalog != nil }
    var accessibilityDescription: String {
        "\(catalog == nil ? "Available media" : "Media"): \(images) images, \(links) links, \(files) files"
    }
}

struct NativeMediaSummaryButton: View {
    let summary: NativeMediaSummary
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    Text(summary.caption)
                    Label("\(summary.images)", systemImage: "photo")
                    Label("\(summary.links)", systemImage: "link")
                    Label("\(summary.files)", systemImage: "doc")
                }
                Label("\(summary.total) \(summary.catalog == nil ? "available" : "items")", systemImage: "photo.on.rectangle")
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
