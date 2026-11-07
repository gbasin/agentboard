import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct FileUploadSheet: View {
    let server: String
    @ObservedObject var terminal: TerminalBridge
    @ObservedObject private var upload: NativePasteController
    @State private var picker = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var reading = false
    @State private var readTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    init(server: String, terminal: TerminalBridge) {
        self.server = server; self.terminal = terminal; self.upload = terminal.clipboard
    }
    private var busy: Bool { reading || upload.busy }
    var body: some View {
        NavigationStack {
            Form {
                NativePasteStatus(controller: upload)
                Button("Choose file", systemImage: "doc") { picker = true }.disabled(busy)
                PhotosPicker(selection: $photos, matching: .images) { Label("Choose photo", systemImage: "photo") }.disabled(busy)
                if reading { ProgressView("Reading files…") }
                if case .prepared(let paths) = upload.state {
                    ForEach(Array(paths.enumerated()), id: \.offset) { _, path in Text(URL(fileURLWithPath: path).lastPathComponent) }
                    Button("Insert file path") { upload.insert(); dismiss() }.disabled(!terminal.ready)
                }
                Text("Files upload to the connected server, up to 40 MB each. Insert adds files or image attachments without pressing Enter.").font(.footnote)
            }.navigationTitle("Attach file").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
                .fileImporter(isPresented: $picker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                    switch result {
                    case .success(let urls): read {
                        NativePastePayload(files: try urls.map { try NativePasteFile.read($0) })
                    }
                    case .failure(let failure): upload.fail(failure)
                    }
                }
                .onChange(of: photos) { _, items in
                    read {
                        var files: [NativePasteFile] = []
                        for item in items {
                            try Task.checkCancellation()
                            if let data = try await item.loadTransferable(type: Data.self) {
                                let type = item.supportedContentTypes.first
                                files.append(.init(data: data, name: "photo.\(type?.preferredFilenameExtension ?? "jpg")", mime: type?.preferredMIMEType ?? "image/jpeg"))
                            }
                        }
                        return NativePastePayload(files: files)
                    }
                }
                .onDisappear { readTask?.cancel(); upload.cancel() }
        }
    }
    private func read(_ operation: @escaping () async throws -> NativePastePayload) {
        readTask?.cancel(); upload.cancel(); reading = true
        readTask = Task { @MainActor in
            defer { reading = false }
            do {
                let payload = try await operation()
                try Task.checkCancellation()
                upload.submit(payload, immediately: false)
            } catch { if !Task.isCancelled { upload.fail(error) } }
        }
    }
}
struct NumberKeys: View {
    @ObservedObject var terminal: TerminalBridge
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 64, maximum: 96), spacing: 12), count: 3), spacing: 12) {
                    ForEach(["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "-"] , id: \.self) { key in
                        Button { terminal.send(key) } label: {
                            Text(key).frame(maxWidth: .infinity, minHeight: 44)
                        }.buttonStyle(.bordered)
                    }
                    Button { terminal.send("\u{7f}") } label: {
                        Label("Delete", systemImage: "delete.left").labelStyle(.iconOnly).frame(maxWidth: .infinity, minHeight: 44)
                    }.buttonStyle(.bordered)
                    Button { terminal.send("\r") } label: {
                        Label("Enter", systemImage: "return").labelStyle(.iconOnly).frame(maxWidth: .infinity, minHeight: 44)
                    }.buttonStyle(.bordered).accessibilityIdentifier("number-enter")
                }.font(.title2).dynamicTypeSize(...DynamicTypeSize.xxxLarge).padding()
            }.navigationTitle("Number keys").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.height(500), .large])
    }
}
