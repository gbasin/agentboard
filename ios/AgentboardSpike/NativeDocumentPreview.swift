import SwiftUI
import QuickLook
import UniformTypeIdentifiers

/// Documents may intentionally be downloads on the server. Preview a private local copy through iOS.
struct NativeDocumentPreview: View {
    let url: URL
    let mediaType: String?
    private enum Phase { case loading, ready(URL), failed(String) }
    @State private var phase: Phase = .loading
    @State private var retry = 0
    var body: some View {
        Group {
            switch phase {
            case .loading: ProgressView("Downloading document…")
            case .failed(let message):
                ContentUnavailableView {
                    Label("Document unavailable", systemImage: "doc")
                } description: { Text(message) } actions: {
                    Button("Retry") { retry += 1 }
                    Link("Open in browser", destination: url)
                }
            case .ready(let file):
                VStack(spacing: 0) {
                    if UTType(filenameExtension: file.pathExtension)?.conforms(to: .html) == true {
                        DocumentSourcePreview(file: file)
                    } else if QLPreviewController.canPreview(file as NSURL) {
                        DocumentQuickLook(file: file).accessibilityIdentifier("document-preview")
                    } else {
                        ContentUnavailableView("File downloaded", systemImage: "doc",
                            description: Text("Use Share to save this file or open it in another app."))
                    }
                    ShareLink(item: file) { Label("Share document", systemImage: "square.and.arrow.up").frame(minHeight: 44) }
                        .padding(.horizontal, 16).nativeGlassSurface().padding()
                }
            }
        }
        .task(id: "\(url.absoluteString)|\(retry)") {
            clean(); phase = .loading
            do {
                let file = try await DocumentDownload.load(url: url, mediaType: mediaType)
                guard !Task.isCancelled else { DocumentDownload.remove(file); return }
                phase = .ready(file)
            } catch {
                if !Task.isCancelled { phase = .failed(error.localizedDescription) }
            }
        }
        .onDisappear { clean() }
    }
    private func clean() {
        if case .ready(let file) = phase { DocumentDownload.remove(file) }
    }
}

enum DocumentDownload {
    static let maximumBytes = 50 * 1024 * 1024
    static func load(url: URL, mediaType: String?) async throws -> URL {
        var request = URLRequest(url: url); request.timeoutInterval = 60
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SessionActionError(message: "The server could not provide this document.")
        }
        guard response.expectedContentLength <= maximumBytes else {
            throw SessionActionError(message: "This document exceeds the 50 MB preview limit. Open it in your browser.")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AgentboardDocument-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let type = mediaType?.components(separatedBy: ";").first ?? response.mimeType ?? "application/octet-stream"
        let ext = UTType(mimeType: type)?.preferredFilenameExtension ?? "bin"
        let file = directory.appendingPathComponent("Document.\(ext)")
        do {
            _ = FileManager.default.createFile(atPath: file.path, contents: nil)
            let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
            var buffer = Data(), count = 0
            for try await byte in bytes {
                try Task.checkCancellation(); count += 1
                guard count <= maximumBytes else {
                    throw SessionActionError(message: "This document exceeds the 50 MB preview limit. Open it in your browser.")
                }
                buffer.append(byte)
                if buffer.count == 64 * 1024 { try handle.write(contentsOf: buffer); buffer.removeAll(keepingCapacity: true) }
            }
            try handle.write(contentsOf: buffer)
            try Task.checkCancellation()
            return file
        } catch { try? FileManager.default.removeItem(at: directory); throw error }
    }
    static func remove(_ file: URL) { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
}

private struct DocumentQuickLook: UIViewControllerRepresentable {
    let file: URL
    func makeCoordinator() -> Coordinator { Coordinator(file: file) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.file != file { context.coordinator.file = file; controller.reloadData() }
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var file: URL
        init(file: URL) { self.file = file }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { file as NSURL }
    }
}

/// HTML attachments are source files, not trusted executable previews.
private struct DocumentSourcePreview: View {
    let file: URL
    @State private var text: String?
    @State private var truncated = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("HTML source").font(.headline)
                if let text { Text(text).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
                else { ProgressView("Reading document…") }
                if truncated { Text("Showing the first 256 KB. Share the document to open the complete file.").font(.footnote) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .task(id: file) {
            do {
                let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
                let data = try handle.read(upToCount: 256 * 1024 + 1) ?? Data()
                truncated = data.count > 256 * 1024
                text = String(decoding: data.prefix(256 * 1024), as: UTF8.self)
            } catch { text = "Could not read the source preview. Use Share to open the downloaded file." }
        }
    }
}
