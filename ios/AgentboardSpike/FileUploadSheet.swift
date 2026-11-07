import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct FileUploadSheet: View {
    let server: String
    @ObservedObject var terminal: TerminalBridge
    @State private var picker = false
    @State private var photo: PhotosPickerItem?
    @State private var uploadedPath: String?
    @State private var error: String?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                if let error { ErrorRow(message: error) }
                Button("Choose file", systemImage: "doc") { picker = true }.disabled(busy)
                PhotosPicker(selection: $photo, matching: .images) { Label("Choose photo", systemImage: "photo") }.disabled(busy)
                if busy { ProgressView("Uploading…") }
                if let path = uploadedPath {
                    Text(URL(fileURLWithPath: path).lastPathComponent)
                    Button("Insert file path") { terminal.paste(BoardAPI.shellQuote(path)); dismiss() }.disabled(!terminal.ready)
                }
                Text("Files upload to the connected server, up to 40 MB. Insert pastes a quoted path without pressing Enter.").font(.footnote)
            }.navigationTitle("Attach file").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) } }
                .interactiveDismissDisabled(busy)
                .fileImporter(isPresented: $picker, allowedContentTypes: [.item]) { result in
                    switch result {
                    case .success(let url):
                        Task {
                            let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                            do {
                                if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 40 * 1024 * 1024 { throw SessionActionError(message: "File exceeds the 40 MB limit.") }
                                try await upload(Data(contentsOf: url), name: url.lastPathComponent)
                            } catch { self.error = error.localizedDescription }
                        }
                    case .failure(let failure): error = failure.localizedDescription
                    }
                }
                .onChange(of: photo) { _, item in
                    Task { do {
                        if let data = try await item?.loadTransferable(type: Data.self) {
                            let ext = item?.supportedContentTypes.compactMap(\.preferredFilenameExtension).first ?? "jpg"
                            try await upload(data, name: "photo.\(ext)")
                        }
                    } catch { self.error = error.localizedDescription } }
                }
        }
    }
    private func upload(_ data: Data, name: String) async throws {
        guard !busy else { return }; busy = true; error = nil; uploadedPath = nil; defer { busy = false }
        uploadedPath = try await BoardAPI(server).upload(data, name: name)
    }
}
struct NumberKeys: View {
    @ObservedObject var terminal: TerminalBridge
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack { LazyVGrid(columns: Array(repeating: GridItem(.fixed(64)), count: 3)) {
            ForEach(["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "-"] , id: \.self) { key in
                Button(key) { terminal.send(key) }.frame(width: 64, height: 44).buttonStyle(.bordered)
            }
            Button("Delete", systemImage: "delete.left") { terminal.send("\u{7f}") }.labelStyle(.iconOnly).frame(minHeight: 44)
            Button("Enter", systemImage: "return") { terminal.send("\r") }.labelStyle(.iconOnly).frame(minHeight: 44).accessibilityIdentifier("number-enter")
        }.padding().navigationTitle("Number keys").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium])
    }
}
