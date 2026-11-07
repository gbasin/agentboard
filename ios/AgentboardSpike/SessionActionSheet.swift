import SwiftUI

/// Native management forms keep drafts and server errors together until confirmed.
enum SessionActionRoute: Identifiable {
    case create, rename(BoardSession), end(BoardSession)
    var id: String {
        switch self { case .create: "create"; case .rename(let s): "rename-\(s.id)"; case .end(let s): "end-\(s.id)" }
    }
    var title: String {
        switch self { case .create: "New session"; case .rename: "Rename session"; case .end: "End session" }
    }
}

struct SessionActionSheet: View {
    let route: SessionActionRoute
    let serverURL: String
    let completed: (BoardSession?) -> Void
    @FocusState private var focusedField: String?
    @State private var project = ""
    @State private var name = ""
    @State private var command = ""
    @State private var host = ""
    @State private var failure: String?
    @State private var request: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    private func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool {
        switch route {
        case .create: !trimmed(project).isEmpty && !trimmed(command).isEmpty
        case .rename: !trimmed(name).isEmpty
        case .end: true
        }
    }
    var body: some View {
        NavigationStack {
            Form {
                if let failure {
                    Section {
                        Label { Text(failure).foregroundStyle(.primary) } icon: {
                            Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                        }.accessibilityIdentifier("action-error")
                    }
                }
                switch route {
                case .create:
                    Section {
                        TextField("Project directory", text: $project).accessibilityIdentifier("session-project").focused($focusedField, equals: "project")
                        TextField("Command", text: $command).accessibilityIdentifier("session-command").focused($focusedField, equals: "command")
                        TextField("Name (optional)", text: $name).accessibilityIdentifier("session-name").focused($focusedField, equals: "name")
                    } footer: { Text("The directory and command run on the Agentboard server. For example: /path/to/project and codex.") }
                    Section {
                        TextField("Remote host (optional)", text: $host).accessibilityIdentifier("session-host").focused($focusedField, equals: "host")
                    } footer: { Text("Leave blank to use the connected server. A remote host must be configured in Agentboard.") }
                case .rename:
                    Section("Name") { TextField("Name", text: $name).accessibilityIdentifier("session-name").focused($focusedField, equals: "name") }
                case .end(let session):
                    Section {
                        Text(session.name).font(.headline)
                        Text("Ending this session stops its terminal and running processes. This cannot be undone.")
                        Button("End session", role: .destructive) { submit() }
                            .disabled(request != nil).accessibilityIdentifier("confirm-end-session")
                    }
                }
                if request != nil { ProgressView("Waiting for server…") }

            }
            .disabled(request != nil)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .navigationTitle(route.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(request != nil)
                }
                ToolbarItem(placement: .confirmationAction) {
                    switch route {
                    case .end: EmptyView()
                    case .create, .rename:
                        Button(route.id == "create" ? "Create" : "Save") { submit() }
                            .disabled(!valid || request != nil)
                    }
                }
            }
            .onAppear { if case .rename(let session) = route { name = session.name } }
        }
        .interactiveDismissDisabled(request != nil)
        .onChange(of: scenePhase) { _, phase in if phase == .background { request?.cancel() } }
        .onDisappear { request?.cancel() }
    }
    private func submit() {
        guard request == nil, valid else { return }
        focusedField = nil
        failure = nil
        let action: SessionAction
        switch route {
        case .create: action = .create(project: trimmed(project), name: trimmed(name), command: trimmed(command), host: trimmed(host))
        case .rename(let session): action = .rename(id: session.id, name: trimmed(name))
        case .end(let session): action = .end(id: session.id)
        }
        request = Task { @MainActor in
            defer { request = nil }
            do {
                let result = try await SessionActions().perform(action, at: ServerAddress(serverURL))
                completed(result)
                dismiss()
            } catch { failure = error.localizedDescription }
        }
    }
}
