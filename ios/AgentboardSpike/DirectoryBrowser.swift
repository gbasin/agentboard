import SwiftUI

struct DirectoryBrowser: View {
    let server: String
    let initial: String
    let choose: (String) -> Void
    @State private var path = ""
    @State private var page: DirectoryPage?
    @State private var error: String?
    @State private var loading = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Directory path", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { Task { await load(path) } }.accessibilityIdentifier("browse-path")
                    Button("Go") { Task { await load(path) } }.disabled(loading)
                }
                if let error { ErrorRow(message: error) { Task { await load(path) } } }
                if loading { ProgressView("Loading directories…") }
                if let page {
                    if let parent = page.parent { Button("Parent directory", systemImage: "arrow.up") { Task { await load(parent) } } }
                    ForEach(page.directories) { entry in
                        Button(entry.name, systemImage: "folder") { Task { await load(entry.path) } }
                    }
                    if page.directories.isEmpty { Text("No subdirectories").foregroundStyle(.secondary) }
                    if page.truncated { Text("Only the first directories are shown. Enter a path to navigate directly.").font(.footnote) }
                }
            }
            .navigationTitle("Choose directory").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Choose") { if let page { choose(page.path); dismiss() } }.disabled(page == nil || loading)
                }
            }
            .task { await load(initial.isEmpty ? "~" : initial) }
        }
    }
    private func load(_ value: String) async {
        guard !loading else { return }; loading = true; error = nil; page = nil; path = value
        defer { loading = false }
        do { let result: DirectoryPage = try await BoardAPI(server).request("api/directories", query: ["path": value]); page = result; path = result.path }
        catch { self.error = error.localizedDescription }
    }
}
struct ErrorRow: View {
    let message: String
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label { Text(message).foregroundStyle(.primary) } icon: { Image(systemName: "exclamationmark.circle").foregroundStyle(.red) }
            if let retry { Button("Retry", action: retry) }
        }
    }
}
