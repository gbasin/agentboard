import SwiftUI

struct LibraryView: View {
    let server: String
    @ObservedObject var board: BoardConnection
    @ObservedObject private var conversations: AgentConversationCatalog
    @ObservedObject var preferences: NativePreferences
    let open: (BoardSession) -> Void
    @State private var sessions: [SavedSession] = []
    @State private var cursor: String?
    @State private var query = ""
    @State private var state = "all"
    @State private var pinned = false
    @State private var loading = false
    @State private var failure: String?
    @State private var detail: SavedSession?
    @Environment(\.dismiss) private var dismiss
    init(server: String, board: BoardConnection, preferences: NativePreferences, initialState: String = "all", open: @escaping (BoardSession) -> Void) {
        self.server = server
        self.board = board
        self.conversations = board.conversations
        self.preferences = preferences
        self.open = open
        _state = State(initialValue: initialState)
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("State", selection: $state) {
                        Text("All").tag("all"); Text("Hibernating").tag("hibernating")
                        Text("Recovery").tag("interrupted"); Text("Archived").tag("archived")
                        Text("Failed").tag("failed"); Text("Running").tag("running")
                    }
                    Toggle("Pinned only", isOn: $pinned)
                }
                if query.isEmpty { Section("Agent conversations") {
                    NavigationLink("Hibernating conversations (\(filteredSleeping.count))") {
                        AgentHistoryView(server: server, sessions: conversations.snapshot.sleeping, sleeping: true, preferences: preferences, open: finish)
                    }
                    NavigationLink("Conversation history (\(filteredHistory.count))") {
                        AgentHistoryView(server: server, sessions: conversations.snapshot.history, sleeping: false, preferences: preferences, open: finish)
                    }
                }
                }
                if let failure { ErrorRow(message: failure) { Task { await load() } } }
                ForEach(sessions) { saved in
                    Button { detail = saved } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Label(saved.name, systemImage: saved.pinned ? "pin.fill" : "terminal").foregroundStyle(.primary)
                            Text("\(saved.state.capitalized) · \(saved.agentType ?? "Shell")").font(.caption).foregroundStyle(Color.primary)
                            Text(saved.projectPath).font(.caption).foregroundStyle(Color.primary)
                            if let error = saved.error { Text(error).font(.caption) }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(14)
                        .nativeGlassSurface(interactive: true)
                    }.buttonStyle(.plain)
                        .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("saved-\(saved.name)")
                }
                if loading { ProgressView("Loading library…") }
                if sessions.isEmpty && !loading && failure == nil { ContentUnavailableView("No saved sessions", systemImage: "clock") }
                if cursor != nil { Button("Load more") { Task { await load(more: true) } }.disabled(loading) }

            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Library")
            .searchable(text: $query, prompt: "Search saved sessions")
            .onSubmit(of: .search) { Task { await load() } }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(300))
                if !Task.isCancelled { await load() }
            }
            .onChange(of: state) { _, _ in Task { await load() } }
            .onChange(of: pinned) { _, _ in Task { await load() } }
            .onChange(of: board.libraryVersion) { _, _ in Task { await load() } }
            .refreshable { await load() }
            .task { await load() }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $detail) { saved in SavedDetailView(server: server, saved: saved, open: finish) }
        }
    }
    private var filteredSleeping: [AgentLogSession] { selection.conversations(conversations.snapshot.sleeping) }
    private var filteredHistory: [AgentLogSession] { selection.conversations(conversations.snapshot.history) }
    private var selection: CatalogSelection { CatalogSelection(projects: preferences.strings("projectFilters"), hosts: preferences.strings("hostFilters")) }
    private func finish(_ session: BoardSession) { dismiss(); open(session) }
    private func load(more: Bool = false) async {
        guard !loading else { return }; loading = true
        let requestedQuery = query, requestedState = state, requestedPin = pinned
        defer {
            loading = false
            if requestedQuery != query || requestedState != state || requestedPin != pinned { Task { await load() } }
        }
        do {
            var params = ["q": requestedQuery, "state": requestedState, "pinned": String(requestedPin), "limit": "50"]
            if more, let cursor { params["cursor"] = cursor }
            let page: HistoryPage = try await BoardAPI(server).request("api/library", query: params)
            guard requestedQuery == query, requestedState == state, requestedPin == pinned else { return }
            if more { let ids = Set(sessions.map(\.id)); sessions += page.sessions.filter { !ids.contains($0.id) } }
            else { sessions = page.sessions }
            cursor = page.nextCursor; failure = nil
        } catch { failure = error.localizedDescription }
    }
}

struct SavedDetailView: View {
    let server: String
    let saved: SavedSession
    let open: (BoardSession) -> Void
    @State private var detail: HistoryDetail?
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirmArchive = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if let error { ErrorRow(message: error) { Task { await load() } } }
                Section("Session") {
                    TextField("Name", text: $name)
                    Button("Save name") { update(["name": name]) }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                    Text(saved.projectPath).textSelection(.enabled)
                    Text(detail?.session.state.capitalized ?? saved.state.capitalized)
                    Button("Resume session", systemImage: "play") { resume() }.disabled(busy)
                    Button((detail?.session.pinned ?? saved.pinned) ? "Unpin" : "Pin", systemImage: "pin") {
                        update(["pinned": !(detail?.session.pinned ?? saved.pinned)])
                    }.disabled(busy)
                    Button("Archive session", role: .destructive) { confirmArchive = true }.disabled(busy)
                }
                if busy { ProgressView("Waiting for server…") }
                if let preview = detail?.terminalPreview ?? saved.preview {
                    Section("Terminal preview") { Text(preview).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }
                if let detail {
                    if !detail.conversations.isEmpty { Section("Conversations") {
                        ForEach(detail.conversations) { conversation in
                            NavigationLink(conversation.displayName) { TranscriptView(server: server, sessionID: conversation.id, title: conversation.displayName) }
                        }
                    }
                    }
                    Section("Lifecycle events") {
                        ForEach(detail.events) { event in VStack(alignment: .leading) {
                            Text(event.kind); Text(event.createdAt).font(.caption).foregroundStyle(.secondary)
                            if let detail = event.detail { Text(detail).font(.caption).textSelection(.enabled) }
                        } }
                    }
                }
            }.navigationTitle("Saved session").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(busy) } }
                .interactiveDismissDisabled(busy)
                .task { name = saved.name; await load() }
                .confirmationDialog("Archive \(saved.name)?", isPresented: $confirmArchive, titleVisibility: .visible) {
                    Button("Archive session", role: .destructive) { update(["state": "archived"]) }
                } message: { Text("This stops any running terminal. The saved session stays in the library.") }
        }
    }
    private func load() async {
        do { detail = try await BoardAPI(server).request("api/library/\(saved.id)"); error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func update(_ body: [String: Any]) {
        guard !busy else { return }; busy = true
        Task { defer { busy = false }; do {
            let _: SavedSession = try await BoardAPI(server).request("api/library/\(saved.id)", method: "PATCH", body: body); await load()
        } catch { self.error = error.localizedDescription } }
    }
    private func resume() {
        guard !busy else { return }; busy = true
        Task { defer { busy = false }; do {
            let session: RemoteSession = try await BoardAPI(server).request("api/library/\(saved.id)/resume", method: "POST", body: ["operationId": UUID().uuidString])
            dismiss(); open(session.boardSession)
        } catch { self.error = error.localizedDescription } }
    }
}

struct AgentHistoryView: View {
    let server: String
    let sessions: [AgentLogSession]
    let sleeping: Bool
    @ObservedObject var preferences: NativePreferences
    let open: (BoardSession) -> Void
    @State private var search = ""
    @State private var busy: String?
    @State private var error: String?
    @State private var archived = Set<String>()
    @State private var renaming: AgentLogSession?
    @State private var newName = ""
    @State private var renamed: [String: String] = [:]
    var body: some View {
        List {
            if let error { ErrorRow(message: error) }
            ForEach(filteredSessions.filter { !archived.contains($0.id) && (search.isEmpty || "\($0.displayName) \($0.projectPath)".localizedCaseInsensitiveContains(search)) }) { session in
                Section {
                    NavigationLink(renamed[session.id] ?? session.displayName) { TranscriptView(server: server, sessionID: session.id, title: session.displayName) }
                    Text(session.projectPath).font(.caption)
                    if let error = session.lastResumeError { Text(error).font(.caption) }
                    Button("Rename conversation") { newName = renamed[session.id] ?? session.displayName; renaming = session }.disabled(busy != nil)
                    Button(sleeping ? "Wake" : "Resume") { action("session-wake", session) }.disabled(busy != nil)
                    if sleeping { Button("Move to history") { action("session-move-to-history", session) }.disabled(busy != nil) }
                    if session.mediaSummary != nil || !(session.media ?? []).isEmpty || !(session.prs ?? []).isEmpty {
                        NavigationLink("Media and links") { SessionContentView(server: server, media: session.media ?? [], prs: session.prs ?? [], sessionID: session.sessionId, catalog: session.mediaSummary) }
                    }
                }
            }
            if busy != nil { ProgressView("Waiting for server…") }
            if sessions.isEmpty { ContentUnavailableView("No conversations", systemImage: "text.bubble") }
            else if filteredSessions.isEmpty { ContentUnavailableView("No matching conversations", systemImage: "text.bubble", description: Text("Change the project or host filters in Sessions.")) }
        }.navigationTitle(sleeping ? "Hibernating" : "Conversations").searchable(text: $search)
            .alert("Rename conversation", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $newName)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Save") {
                    guard let session = renaming else { return }; busy = session.id
                    Task { defer { busy = nil }; do {
                        _ = try await SessionActions().perform(.renameConversation(id: session.id, name: newName), at: ServerAddress(server))
                        renamed[session.id] = newName
                    } catch { self.error = error.localizedDescription } }
                }.disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
    }
    private var filteredSessions: [AgentLogSession] {
        CatalogSelection(projects: preferences.strings("projectFilters"), hosts: preferences.strings("hostFilters")).conversations(sessions)
    }
    private func action(_ type: String, _ session: AgentLogSession) {
        guard busy == nil else { return }; busy = session.id
        Task { defer { busy = nil }; do {
            let result = try await SessionActions().perform(.lifecycle(type: type, id: session.id), at: ServerAddress(server))
            if let result { open(result) } else { archived.insert(session.id) }
        } catch { self.error = error.localizedDescription } }
    }
}
