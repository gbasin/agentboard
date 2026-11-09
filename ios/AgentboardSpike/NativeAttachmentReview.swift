import SwiftUI
import ImageIO

/// Preview original attachments before uploading; thumbnail decoding is bounded.
struct NativeAttachmentReview: View {
    @Environment(\.dynamicTypeSize) private var dynamicType
    @ObservedObject var controller: NativePasteController
    var showsCancel = true
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !controller.reviewText.isEmpty {
                Text(controller.reviewText).font(.callout).lineLimit(2)
            }
            ScrollView(dynamicType.isAccessibilitySize ? .vertical : .horizontal) {
                let layout = dynamicType.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
                layout {
                    ForEach(Array(controller.reviewFiles.enumerated()), id: \.offset) { index, file in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                AttachmentThumbnail(file: file)
                                Button("Remove \(file.name)", systemImage: "xmark.circle.fill") {
                                    controller.removeReviewFile(at: index)
                                }.labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                                    .accessibilityIdentifier("remove-attachment-\(index)")
                            }
                            Text(file.name).font(.caption).lineLimit(dynamicType.isAccessibilitySize ? nil : 2).fixedSize(horizontal: false, vertical: true)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(file.data.count), countStyle: .file))
                                .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }.frame(width: dynamicType.isAccessibilitySize ? nil : 160, alignment: .leading)
                            .frame(maxWidth: dynamicType.isAccessibilitySize ? .infinity : nil, alignment: .leading)
                    }
                }
            }.frame(height: dynamicType.isAccessibilitySize ? 220 : 130).accessibilityIdentifier("attachment-previews")
            let actions = dynamicType.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
            actions {
                Button { controller.confirmReview() } label: {
                    Text(controller.reviewAction).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: dynamicType.isAccessibilitySize ? .infinity : nil)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(dynamicType.isAccessibilitySize ? .roundedRectangle(radius: 16) : .automatic)
                .accessibilityIdentifier("confirm-attachments")
                if !dynamicType.isAccessibilitySize { Spacer() }
                if showsCancel { Button("Cancel") { controller.cancel() }.fixedSize(horizontal: false, vertical: true) }
            }
        }.padding(8)
    }
}
private struct AttachmentThumbnail: View {
    let file: NativePasteFile
    @State private var thumbnail: UIImage?
    var body: some View {
        Group {
            if let thumbnail { Image(uiImage: thumbnail).resizable().scaledToFit() }
            else { Image(systemName: file.isImage ? "photo" : "doc").font(.title2).foregroundStyle(.secondary) }
        }.frame(width: 64, height: 64).accessibilityHidden(true)
            .task(id: file.data) {
                thumbnail = nil
                guard file.isImage, let source = CGImageSourceCreateWithData(file.data as CFData, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceThumbnailMaxPixelSize: 192,
                        kCGImageSourceCreateThumbnailWithTransform: true
                      ] as CFDictionary) else { return }
                thumbnail = UIImage(cgImage: image)
            }
    }
}
