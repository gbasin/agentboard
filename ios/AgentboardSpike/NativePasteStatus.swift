import SwiftUI

/// Visible only while upload work needs attention; the normal terminal retains one key row.
struct NativePasteStatus: View {
    @ObservedObject var controller: NativePasteController
    var onReview: (() -> Void)? = nil
    var showsReviewCancel = true
    var body: some View {
        switch controller.state {
        case .reviewing:
            NativeAttachmentReview(controller: controller, showsCancel: showsReviewCancel).onAppear { onReview?() }
        case .reading:
            HStack { ProgressView("Reading clipboard…"); Spacer(); Button("Cancel") { controller.cancel() } }.padding(8)
        case .uploading:
            HStack { ProgressView("Uploading files…"); Spacer(); Button("Cancel") { controller.cancel() } }.padding(8)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Text(message).font(.callout)
                HStack {
                    if controller.canRetry { Button("Retry paste") { controller.retry() } }
                    Button("Dismiss") { controller.dismissError() }
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading).background(.bar)
        default: EmptyView()
        }
    }
}
