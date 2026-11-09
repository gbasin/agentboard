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
    @StateObject private var recovery = RecoveryNoticeModel()
    private enum LibraryRoute: String, Identifiable {
        case all, recovery
        var id: String { rawValue }
        var initialState: String { self == .recovery ? "interrupted" : "all" }
    }
    @State private var libraryRoute: LibraryRoute?
    @State private var showSettings = false
    @State private var showFilters = false
    @State private var statusFilter = "All"
    @AppStorage("serverURL") private var serverURL = ""
    @State private var search = ""
    @State private var path: [BoardSession] = []
    @State private var showConnection = false
    @State private var action: SessionActionRoute?
    private enum DetailRoute: Identifiable {
        case pullRequests(BoardSession), activity(BoardSession)
        var session: BoardSession {
            switch self { case .pullRequests(let session), .activity(let session): session }
        }
        var id: String {
            switch self { case .pullRequests: "prs-" + session.id; case .activity: "activity-" + session.id }
        }
    }
    @State private var detailRoute: DetailRoute?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var selection: CatalogSelection {
        CatalogSelection(projects: preferences.strings("projectFilters"), hosts: preferences.strings("hostFilters"))
    }
    private var activeFilterCount: Int { selection.activeCount + (statusFilter == "All" ? 0 : 1) }
    private var hiddenPermissionCount: Int { selection.hiddenPermissions(in: board.sessions) }
    private var filtered: [BoardSession] {
        let result = board.sessions.filter {
            (search.isEmpty || "\($0.name) \($0.project) \($0.summary)".localizedCaseInsensitiveContains(search)) &&
            (statusFilter == "All" || $0.status.rawValue == statusFilter) &&
            selection.includes(project: $0.project, host: $0.host)
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
                if board.state != .connected { Section {
                    adaptiveRow {
                        Label(board.state.label, systemImage: board.state == .connected ? "network" : "wifi.exclamationmark")
                            .font(.subheadline)
                        if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                        if board.state != .connected && !serverURL.isEmpty {
                            Button("Retry") { board.reconnect() }.buttonStyle(.borderless)
                        }
                    }
                    .accessibilityIdentifier("connection-detail")
                } footer: {
                    if let address = try? ServerAddress(serverURL) { Text(address.baseURL.absoluteString) }
                }
                }
                RecoveryNoticeView(open: { libraryRoute = .recovery }, model: recovery)
                if hiddenPermissionCount > 0 {
                    Section {
                        Button {
                            preferences.set("projectFilters", .array([])); preferences.set("hostFilters", .array([]))
                            search = ""; statusFilter = "All"
                        } label: {
                            Label {
                                Text("\(hiddenPermissionCount) hidden session\(hiddenPermissionCount == 1 ? "" : "s") need\(hiddenPermissionCount == 1 ? "s" : "") approval. Clear filters")
                                    .foregroundStyle(Color.primary)
                            } icon: { Image(systemName: "exclamationmark.circle").foregroundStyle(.orange) }
                        }.accessibilityIdentifier("hidden-permission-notice")
                    }
                }
                Section {
                    ForEach(filtered) { session in
                        NativeSessionRow(session: session, preferences: preferences, canOpen: board.canOpen(session),
                                         onOpen: { path.append(session) },
                                         onPullRequests: { detailRoute = .pullRequests(session) },
                                         onSubagents: { detailRoute = .activity(session) })
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .nativeGlassSurface(cornerRadius: 12)
                            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .contextMenu {
                                if SessionCapabilities.canControl(session, remoteAllowed: board.remoteAllowControl) {
                                    Button("Rename session", systemImage: "pencil") { action = .rename(session) }
                                    Button("Duplicate session", systemImage: "plus.square.on.square") { action = .duplicate(session) }
                                    Button("End session", systemImage: "xmark.circle", role: .destructive) { action = .end(session) }
                                }
                                if SessionCapabilities.canHibernate(session) {
                                    Button("Hibernate session", systemImage: "moon") { action = .hibernate(session) }
                                }
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
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Sessions")
            .searchable(text: $search, prompt: "Find a session")
            .refreshable { board.refresh() }
            .toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Library", systemImage: "clock") { libraryRoute = .all }
                    Spacer()
                    Button { showFilters = true } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "line.3.horizontal.decrease")
                            if activeFilterCount > 0 { Text("\(activeFilterCount)").font(.caption).monospacedDigit() }
                        }
                    }
                    .accessibilityLabel("Filter and sort")
                    .accessibilityValue(activeFilterCount == 0 ? "No active filters" : "\(activeFilterCount) active filters")
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
                    Button { showConnection = true } label: {
                        Label(board.state == .connected ? "Connected" : "Connection", systemImage: "network")
                            .labelStyle(.titleAndIcon).font(.subheadline)
                    }
                    .accessibilityIdentifier("connection-status")
                    .accessibilityLabel("Connection, \(board.state.label)")
                    .accessibilityHint("Edit server address")
                }
            }
            .navigationDestination(for: BoardSession.self) { selected in
                TerminalScreen(session: .constant(selected), endpoint: "", live: board, serverURL: serverURL, onEnd: {},
                               onSwitch: { path = [$0] }, onManage: { action = $0 }).id(selected.id)
            }
            .sheet(item: $detailRoute) { route in
                let current = board.sessions.first { $0.id == route.session.id } ?? route.session
                switch route {
                case .activity: NativeSubagentActivityView(session: current)
                case .pullRequests:
                    NavigationStack {
                        SessionContentView(server: serverURL, media: [], prs: current.prs, showsMedia: false)
                            .toolbar { ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { detailRoute = nil }
                            } }
                    }
                }
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
            .sheet(item: $libraryRoute) { route in LibraryView(server: serverURL, board: board, preferences: preferences, initialState: route.initialState) { session in
                board.refresh(); search = ""; path = [session]
            } }
            .sheet(isPresented: $showSettings) { NativeSettingsView(preferences: preferences) }
            .sheet(isPresented: $showFilters) { CatalogFilters(preferences: preferences, sessions: board.sessions, conversations: board.conversations, hosts: board.hosts, status: $statusFilter) }
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
        .task(id: serverURL + String(describing: scenePhase)) {
            recovery.configure(serverURL)
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await recovery.refresh(serverURL)
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .onChange(of: board.libraryVersion) { _, _ in
            guard scenePhase == .active else { return }
            Task { await recovery.refresh(serverURL) }
        }
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
