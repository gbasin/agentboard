import SwiftUI
import Inject

/// Live catalog and native management of server sessions.
struct LiveSessionListView: View {
    @ObserveInjection var inject
    @StateObject private var board: BoardConnection
    @StateObject private var preferences: NativePreferences
    init() {
        let preferences = NativePreferences()
        _preferences = StateObject(wrappedValue: preferences)
        _board = StateObject(wrappedValue: BoardConnection(preferences: preferences))
    }
    @State private var showLibrary = false
    @State private var showSettings = false
    @State private var showFilters = false
    @State private var statusFilter = "All"
    @AppStorage("serverURL") private var serverURL = ""
    @State private var search = ""
    @State private var path: [BoardSession] = []
    @State private var showConnection = false
    @State private var action: SessionActionRoute?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var filtered: [BoardSession] {
        let projects = preferences.strings("projectFilters"), hosts = preferences.strings("hostFilters")
        let result = board.sessions.filter {
            (search.isEmpty || "\($0.name) \($0.project) \($0.summary)".localizedCaseInsensitiveContains(search)) &&
            (statusFilter == "All" || $0.status.rawValue == statusFilter) &&
            (projects.isEmpty || projects.contains($0.project)) &&
            (hosts.isEmpty || hosts.contains($0.host ?? ""))
        }
        switch preferences.string("sessionSortMode", "created") {
        case "manual":
            let order = preferences.strings("manualSessionOrder")
            return result.sorted {
                let lhs = order.firstIndex(of: $0.orderKey) ?? order.firstIndex(of: $0.id) ?? Int.max
                let rhs = order.firstIndex(of: $1.orderKey) ?? order.firstIndex(of: $1.id) ?? Int.max
                return lhs == rhs ? $0.createdAt > $1.createdAt : lhs < rhs
            }
        case "status": return result.sorted {
            if ($0.status == .permission) != ($1.status == .permission) { return $0.status == .permission }
            return $0.lastActivity > $1.lastActivity
        }
        default: return result.sorted { preferences.string("sessionSortDirection", "desc") == "asc" ? $0.createdAt < $1.createdAt : $0.createdAt > $1.createdAt }
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    adaptiveRow {
                        Label(board.state.label, systemImage: board.state == .connected ? "network" : "wifi.exclamationmark")
                            .font(.subheadline)
                        if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                        if board.state != .connected && !serverURL.isEmpty {
                            Button("Retry") { board.reconnect() }.buttonStyle(.borderless)
                        }
                    }
                    .accessibilityIdentifier("connection-status")
                } footer: {
                    if let address = try? ServerAddress(serverURL) { Text(address.baseURL.absoluteString) }
                }
                Section {
                    ForEach(filtered) { session in
                        NavigationLink(value: session) { row(session) }
                            .disabled(!board.canOpen(session))
                            .accessibilityIdentifier("session-\(session.id)")
                            .contextMenu {
                                Button("Rename session", systemImage: "pencil") { action = .rename(session) }
                                Button("Duplicate session", systemImage: "plus.square.on.square") { action = .duplicate(session) }
                                Button("Hibernate session", systemImage: "moon") { action = .hibernate(session) }
                                Button("End session", systemImage: "xmark.circle", role: .destructive) { action = .end(session) }
                            }
                    }.onMove { indices, destination in
                        var ordered = filtered; ordered.move(fromOffsets: indices, toOffset: destination)
                        let visible = Set(ordered.flatMap { [$0.id, $0.orderKey] })
                        let hidden = preferences.strings("manualSessionOrder").filter { !visible.contains($0) }
                        preferences.set("manualSessionOrder", .array((ordered.map(\.orderKey) + hidden).map(JSONValue.string)))
                        preferences.set("sessionSortMode", .string("manual"))
                    }
                }
                if filtered.isEmpty && !board.sessions.isEmpty {
                    ContentUnavailableView {
                        Label("No matching sessions", systemImage: "magnifyingglass")
                    } description: { Text("Change your search or clear the filters.") } actions: {
                        Button("Clear search and filters") {
                            search = ""; statusFilter = "All"
                            preferences.set("projectFilters", .array([])); preferences.set("hostFilters", .array([]))
                        }
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
                                                   description: Text("Tap New session to start a terminal on your server."))
                        } else {
                            ContentUnavailableView("Server unavailable", systemImage: "network",
                                                   description: Text("Check the server address and your Tailscale connection, then tap Retry."))
                        }
                    }
                }
            }
            .navigationTitle("Sessions")
            .searchable(text: $search, prompt: "Find a session")
            .refreshable { board.refresh() }
            .toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Library", systemImage: "clock") { showLibrary = true }
                    Spacer()
                    Button("Filter and sort", systemImage: "line.3.horizontal.decrease") { showFilters = true }
                    Spacer()
                    EditButton()
                    Spacer()
                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New session", systemImage: "plus") { action = .create }
                        .disabled(board.state != .connected)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Connection", systemImage: "network") { showConnection = true }
                }
            }
            .navigationDestination(for: BoardSession.self) { selected in
                TerminalScreen(session: .constant(selected), endpoint: "", live: board, serverURL: serverURL, onEnd: {},
                               onSwitch: { path = [$0] }, onManage: { action = $0 }).id(selected.id)
            }
            .sheet(item: $action) { route in
                SessionActionSheet(route: route, serverURL: serverURL, preferences: preferences, hosts: board.hosts) { result in
                    board.refresh()
                    switch route {
                    case .create, .duplicate: if let result { search = ""; path = [result] }
                    case .end, .hibernate: path.removeAll()
                    case .rename: break
                    }
                }
            }
            .sheet(isPresented: $showLibrary) { LibraryView(server: serverURL, board: board) { session in
                board.refresh(); search = ""; path = [session]
            } }
            .sheet(isPresented: $showSettings) { NativeSettingsView(preferences: preferences) }
            .sheet(isPresented: $showFilters) { CatalogFilters(preferences: preferences, sessions: board.sessions, status: $statusFilter) }
            .sheet(isPresented: $showConnection) {
                ServerConnectionSheet(address: serverURL) { value in
                    path.removeAll()
                    serverURL = value
                    board.configure(value)
                }
            }
        }
        .preferredColorScheme(preferences.string("theme") == "dark" ? .dark : preferences.string("theme") == "light" ? .light : nil)
        .task { board.configure(serverURL) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { board.suspend() }
            else if phase == .active { board.resume() }
        }
        .enableInjection()
    }

    private var adaptiveRow: AnyLayout {
        dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    }

    private func row(_ session: BoardSession) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            adaptiveRow {
                Text(session.name).font(.headline)
                    .fixedSize(horizontal: false, vertical: dynamicTypeSize.isAccessibilitySize)
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                SessionStatus(status: session.status)
            }
            if preferences.bool("showProjectName", true) { Text(URL(fileURLWithPath: session.project).lastPathComponent).font(.caption).foregroundStyle(.secondary) }
            if preferences.bool("showSessionIdPrefix"), let id = session.agentSessionID { Text(String(id.prefix(5))).font(.caption.monospaced()) }
            if preferences.bool("showLastUserMessage", true) && !session.summary.isEmpty {
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
