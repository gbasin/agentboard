import SwiftUI

/// Native management forms keep drafts and server errors together until confirmed.
enum SessionActionRoute: Identifiable {
    case create, duplicate(BoardSession), hibernate(BoardSession), rename(BoardSession), end(BoardSession)
    var id: String {
        switch self { case .create: "create"; case .duplicate(let s): "duplicate-\(s.id)"; case .hibernate(let s): "hibernate-\(s.id)"; case .rename(let s): "rename-\(s.id)"; case .end(let s): "end-\(s.id)" }
    }
    var title: String {
        switch self { case .create, .duplicate: "New session"; case .hibernate: "Hibernate session"; case .rename: "Rename session"; case .end: "End session" }
    }
}

struct SessionActionSheet: View {
    let route: SessionActionRoute
    let serverURL: String
    var preferences: NativePreferences? = nil
    var hosts: [HostState] = []
    let completed: (BoardSession?) -> Void
    @FocusState private var focusedField: String?
    @State private var browse = false
    @State private var presetID = ""
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
        case .create, .duplicate: !trimmed(project).isEmpty && !trimmed(command).isEmpty
        case .rename: !trimmed(name).isEmpty
        case .end, .hibernate: true
        }
    }
    var body: some View {
        NavigationStack {
            ScrollViewReader { scroll in
            Form {
                if let failure {
                    Section {
                        Label { Text(failure).foregroundStyle(.primary) } icon: {
                            Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                        }.accessibilityIdentifier("action-error").id("action-error")
                    }
                }
                switch route {
                case .create, .duplicate:
                    if let preferences {
                        Section("Command preset") {
                            Picker("Preset", selection: $presetID) {
                                Text("Custom").tag("")
                                ForEach(preferences.presets) { Text($0.label).tag($0.id) }
                            }.onChange(of: presetID) { _, value in
                                if let preset = preferences.presets.first(where: { $0.id == value }) { command = preset.command }
                            }
                        }
                    }
                    Section {
                        FormField("Project directory") { TextField("Project directory", text: $project).accessibilityIdentifier("session-project").focused($focusedField, equals: "project") }
                        FormField("Command") { TextField("Command", text: $command).accessibilityIdentifier("session-command").focused($focusedField, equals: "command") }
                        FormField("Name (optional)") { TextField("Name (optional)", text: $name).accessibilityIdentifier("session-name").focused($focusedField, equals: "name") }
                    } footer: { Text("The directory and command run on the Agentboard server. For example: /path/to/project and codex.") }
                    if permission.available {
                        Toggle("Skip permission prompts", isOn: Binding(get: { permission.enabled }, set: { command = CommandPermission.set(command, enabled: $0) }))
                            .disabled(permission.conflict != nil && !permission.enabled)
                        if let conflict = permission.conflict { Text(conflict).font(.footnote) }
                    }
                    Section {
                        if !hosts.isEmpty {
                            Picker("Host", selection: $host) {
                                Text("Connected server").tag("")
                                ForEach(hosts) { Text($0.host + ($0.ok ? "" : " · unavailable")).tag($0.host) }
                            }
                        }
                        FormField("Remote host (optional)") { TextField("Remote host (optional)", text: $host).accessibilityIdentifier("session-host").focused($focusedField, equals: "host") }
                    } footer: { Text("Leave blank to use the connected server. A remote host must be configured in Agentboard.") }
                    if host.isEmpty {
                        Button("Browse directories", systemImage: "folder") { browse = true }
                    }
                    if let preferences, !preferences.strings("recentPaths").isEmpty {
                        Section("Recent directories") {
                            ForEach(preferences.strings("recentPaths"), id: \.self) { path in Button(path) { project = path } }
                        }
                    }
                case .rename:
                    Section("Name") { TextField("Name", text: $name).accessibilityIdentifier("session-name").focused($focusedField, equals: "name") }
                case .end(let session), .hibernate(let session):
                    Section {
                        Text(session.name).font(.headline)
                        Text(isHibernate ? "Stop this terminal and keep the session in the library so it can be resumed later." : "Ending this session stops its terminal and running processes. This cannot be undone.")
                        Button(isHibernate ? "Hibernate session" : "End session", role: .destructive) { submit() }
                            .disabled(request != nil).accessibilityIdentifier("confirm-end-session")
                    }
                }
                if request != nil { ProgressView("Waiting for server…") }

            }
            .onChange(of: failure) { _, message in
                if message != nil { withAnimation { scroll.scrollTo("action-error", anchor: .top) } }
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
                    case .end, .hibernate: EmptyView()
                    case .create, .duplicate, .rename:
                        Button(isCreate ? "Create" : "Save") { submit() }
                            .disabled(!valid || request != nil)
                    }
                }
            }
            .onAppear {
                switch route {
                case .rename(let session): name = session.name
                case .duplicate(let session): project = session.project; command = session.command ?? ""; host = session.remote ? session.host ?? "" : ""
                case .create:
                    if let preferences {
                        project = preferences.string("lastProjectPath", preferences.string("defaultProjectDir", "~"))
                        let preset = preferences.presets.first(where: { $0.id == preferences.string("defaultPresetId") }) ?? preferences.presets.first
                        presetID = preset?.id ?? ""; command = preset?.command ?? ""
                    }
                default: break
                }
            }
            .sheet(isPresented: $browse) { DirectoryBrowser(server: serverURL, initial: project) { project = $0 } }
            }
        }
        .interactiveDismissDisabled(request != nil)
        .onChange(of: scenePhase) { _, phase in if phase == .background { request?.cancel() } }
        .onDisappear { request?.cancel() }
    }
    private var permission: CommandPermission.State { CommandPermission.state(command) }
    private var isCreate: Bool { switch route { case .create, .duplicate: true; default: false } }
    private var isHibernate: Bool { if case .hibernate = route { true } else { false } }
    private func submit() {
        guard request == nil, valid else { return }
        focusedField = nil
        failure = nil
        let action: SessionAction
        switch route {
        case .create, .duplicate: action = .create(project: trimmed(project), name: trimmed(name), command: trimmed(command), host: trimmed(host))
        case .rename(let session): action = .rename(id: session.id, name: trimmed(name))
        case .hibernate(let session): action = .lifecycle(type: "session-hibernate", id: session.agentSessionID ?? session.id)
        case .end(let session): action = .end(id: session.id)
        }
        request = Task { @MainActor in
            defer { request = nil }
            do {
                let result: BoardSession?
                if case .hibernate(let session) = route, let boardID = session.boardID {
                    let _: SavedSession = try await BoardAPI(serverURL).request("api/library/\(boardID)", method: "PATCH", body: ["state": "hibernating"])
                    result = nil
                } else { result = try await SessionActions().perform(action, at: ServerAddress(serverURL)) }
                if isCreate { preferences?.remember(trimmed(project)) }
                completed(result)
                dismiss()
            } catch { failure = error.localizedDescription }
        }
    }
}
