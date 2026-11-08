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
    @State private var readError: String?
    @State private var readTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    init(server: String, terminal: TerminalBridge) {
        self.server = server; self.terminal = terminal; self.upload = terminal.clipboard
    }
    private var busy: Bool { reading || upload.busy }
    var body: some View {
        NavigationStack {
            Form {
                NativePasteStatus(controller: upload, showsReviewCancel: false).disabled(reading)
                if let readError { ErrorRow(message: readError) }
                Button("Choose file", systemImage: "doc") { picker = true }.disabled(busy)
                PhotosPicker(selection: $photos, matching: .images) { Label("Choose photo", systemImage: "photo") }.disabled(busy)
                if reading { ProgressView("Reading files…") }
                Text("Insert attachments uploads to the connected server and adds to your draft. It does not send the prompt. Up to 40 MB per file.").font(.footnote)
            }.navigationTitle("Attach to session").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .fileImporter(isPresented: $picker, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                    switch result {
                    case .success(let urls): read {
                        NativePastePayload(files: try urls.map { try NativePasteFile.read($0) })
                    }
                    case .failure(let failure): readError = failure.localizedDescription
                    }
                }
                .onChange(of: photos) { _, items in
                    guard !items.isEmpty else { return }
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
                .onChange(of: upload.insertionCount) { _, _ in dismiss() }
                .onDisappear { readTask?.cancel(); upload.cancel() }
        }
    }
    private func read(_ operation: @escaping () async throws -> NativePastePayload) {
        readTask?.cancel(); reading = true; readError = nil
        readTask = Task { @MainActor in
            defer { reading = false; photos = [] }
            do {
                let payload = try await operation()
                try Task.checkCancellation()
                try upload.addAttachments(payload)
            } catch { if !Task.isCancelled { readError = error.localizedDescription } }
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
