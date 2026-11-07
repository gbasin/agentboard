import SwiftUI
import Inject

/// Live catalog from the existing Agentboard WebSocket; no sample mutations.
struct LiveSessionListView: View {
    @ObserveInjection var inject
    @StateObject private var board = BoardConnection()
    @AppStorage("serverURL") private var serverURL = ""
    @State private var search = ""
    @State private var path: [BoardSession] = []
    @State private var showConnection = false
    @Environment(\.scenePhase) private var scenePhase

    private var filtered: [BoardSession] {
        board.sessions.filter { search.isEmpty || "\($0.name) \($0.project) \($0.summary)".localizedCaseInsensitiveContains(search) }
    }
    private var projects: [String] { Array(Set(filtered.map(\.project))).sorted() }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    HStack {
                        Label(board.state.label, systemImage: board.state == .connected ? "network" : "wifi.exclamationmark")
                            .font(.subheadline)
                        Spacer()
                        if board.state != .connected && !serverURL.isEmpty {
                            Button("Retry") { board.reconnect() }.buttonStyle(.borderless)
                        }
                    }
                    .accessibilityIdentifier("connection-status")
                } footer: {
                    if let address = try? ServerAddress(serverURL) { Text(address.baseURL.absoluteString) }
                }
                ForEach(projects, id: \.self) { project in
                    Section {
                        ForEach(filtered.filter { $0.project == project }) { session in
                            NavigationLink(value: session) { row(session) }
                                .disabled(!board.canOpen(session))
                                .accessibilityIdentifier("session-\(session.id)")
                        }
                    } header: {
                        Text(project.isEmpty ? "Sessions" : URL(fileURLWithPath: project).lastPathComponent)
                    }
                }
                if board.sessions.isEmpty {
                    Section {
                        if serverURL.isEmpty {
                            ContentUnavailableView {
                                Label("Connect to Agentboard", systemImage: "network")
                            } description: {
                                Text("Use the server address you open in Safari. Keep Tailscale connected on your iPhone.")
                            } actions: {
                                Button("Set server address") { showConnection = true }
                                    .buttonStyle(.borderedProminent)
                            }
                        } else if board.state == .connecting {
                            HStack { Spacer(); ProgressView("Connecting to Agentboard…"); Spacer() }
                                .padding(.vertical, 24)
                        } else if board.state == .connected {
                            ContentUnavailableView("No active sessions", systemImage: "terminal",
                                                   description: Text("Start a session in Agentboard, then pull to refresh."))
                        } else {
                            ContentUnavailableView("Server unavailable", systemImage: "network",
                                                   description: Text("Check the server address and your Tailscale connection, then tap Retry."))
                        }
                    }
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: search)
                }
            }
            .navigationTitle("Sessions")
            .searchable(text: $search, prompt: "Find a session")
            .refreshable { board.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Connection", systemImage: "network") { showConnection = true }
                }
            }
            .navigationDestination(for: BoardSession.self) { selected in
                TerminalScreen(session: .constant(selected), endpoint: "", live: board, onEnd: {})
            }
            .sheet(isPresented: $showConnection) {
                ServerConnectionSheet(address: serverURL) { value in
                    path.removeAll()
                    serverURL = value
                    board.configure(value)
                }
            }
        }
        .task { board.configure(serverURL) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { board.suspend() }
            else if phase == .active { board.resume() }
        }
        .enableInjection()
    }

    private func row(_ session: BoardSession) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.name).font(.headline)
                Spacer(minLength: 8)
                SessionStatus(status: session.status)
            }
            if !session.summary.isEmpty {
                Text(session.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Text([session.agent, session.host].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if !board.canOpen(session) {
                Text(session.status == .sleeping ? "Wake in Agentboard to open" : "Remote attachment disabled by server")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 5)
    }
}

struct ServerConnectionSheet: View {
    let address: String
    let save: (String) -> Void
    @State private var draft = ""
    @Environment(\.dismiss) private var dismiss
    private var parsed: ServerAddress? { try? ServerAddress(draft) }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://your-mac:4040", text: $draft)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityIdentifier("server-address")
                } header: { Text("Agentboard server") } footer: {
                    Text("Enter the same http:// or https:// address you use in Safari. Tailscale must be connected for a tailnet address.")
                }
                if !draft.isEmpty && parsed == nil {
                    Label {
                        Text("Enter a valid http:// or https:// address.").foregroundStyle(.primary)
                    } icon: {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        if let parsed { save(parsed.baseURL.absoluteString); dismiss() }
                    }.disabled(parsed == nil)
                }
            }
            .onAppear { draft = address }
        }.presentationDetents([.medium, .large])
    }
}
