import SwiftUI
import Inject

struct SessionListView: View {
    @ObserveInjection var inject
    @State private var sessions = BoardSession.samples
    @State private var search = ""
    @State private var path: [String] = []
    @State private var showConnection = false
    @State private var showNewSession = false
    @State private var newName = ""
    @AppStorage("spikeEndpoint") private var endpoint = ""

    var filtered: [BoardSession] {
        sessions.filter { search.isEmpty || "\($0.name) \($0.summary)".localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    ForEach(filtered.filter { $0.status != .sleeping }) { session in
                        row(session)
                    }
                } header: { Text("agentboard") }
                if filtered.contains(where: { $0.status == .sleeping }) {
                    Section("Sleeping") {
                        ForEach(filtered.filter { $0.status == .sleeping }) { row($0) }
                    }
                }
                Section {
                    Button { showConnection = true } label: {
                        Label(endpoint.isEmpty ? "Sample sessions" : "Development terminal", systemImage: "network")
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("UI spike · Sample session data. Connect an isolated shell to try terminal input.")
                }
            }
            .overlay {
                if filtered.isEmpty { ContentUnavailableView.search(text: search) }
            }
            .navigationTitle("Sessions")
            .searchable(text: $search, prompt: "Find a session")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Connection", systemImage: "network") { showConnection = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New session", systemImage: "plus") { showNewSession = true }
                }
            }
            .navigationDestination(for: String.self) { id in
                if let index = sessions.firstIndex(where: { $0.id == id }) {
                    TerminalScreen(session: $sessions[index], endpoint: endpoint) {
                        path.removeAll()
                        sessions.removeAll { $0.id == id }
                    }
                }
            }
            .sheet(isPresented: $showConnection) { ConnectionSheet(endpoint: $endpoint) }
            .alert("New sample session", isPresented: $showNewSession) {
                TextField("Session name", text: $newName)
                Button("Cancel", role: .cancel) { newName = "" }
                Button("Create") {
                    let id = UUID().uuidString
                    sessions.append(.init(id: id, name: newName.trimmingCharacters(in: .whitespacesAndNewlines),
                                          project: "agentboard", agent: "Shell", status: .waiting,
                                          summary: "New sample session"))
                    newName = ""
                    path.append(id)
                }.disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: { Text("Creates a local sample for this UI spike.") }
            .onAppear {
                if ProcessInfo.processInfo.arguments.contains("-terminal") && path.isEmpty {
                    path = ["pure-pod-2"]
                }
            }
        }
        .enableInjection()
    }

    private func row(_ session: BoardSession) -> some View {
        NavigationLink(value: session.id) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline) {
                    HarnessIcon(agent: session.agent)
                    Text(session.name).font(.headline)
                    Spacer(minLength: 8)
                    SessionStatus(status: session.status)
                }
                Text(session.summary).font(.subheadline).foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(.vertical, 5)
        }
        .accessibilityIdentifier("session-\(session.id)")
    }
}

struct ConnectionSheet: View {
    @Binding var endpoint: String
    @State private var draft = ""
    @Environment(\.dismiss) private var dismiss
    private var valid: Bool {
        draft.isEmpty || (URL(string: draft).map { ["ws", "wss"].contains($0.scheme ?? "") && $0.host != nil } ?? false)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ws://host:4149", text: $draft)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityIdentifier("endpoint")
                } header: { Text("Development terminal") } footer: {
                    Text("Use the isolated spike shell server. Leave blank for the bundled transcript. Production Agentboard authentication and session attachment are outside this visual spike.")
                }
                if !valid { Text("Enter a ws:// or wss:// address.").foregroundStyle(.red) }
            }
            .navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { endpoint = draft; dismiss() }.disabled(!valid)
                }
            }
            .onAppear { draft = endpoint }
        }
        .presentationDetents([.medium, .large])
    }
}
