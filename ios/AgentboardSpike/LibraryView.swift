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
    private enum Category: String, CaseIterable { case recovery = "Recovery", saved = "Saved", history = "History" }
    @State private var category: Category
    @State private var showFilters = false
    @State private var resuming: String?
    @State private var state = "all"
    @State private var pinned = false
    @State private var loading = false
    @State private var failure: String?
    @State private var detail: SavedSession?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    init(server: String, board: BoardConnection, preferences: NativePreferences, initialState: String = "all", open: @escaping (BoardSession) -> Void) {
        self.server = server
        self.board = board
        self.conversations = board.conversations
        self.preferences = preferences
        self.open = open
        _state = State(initialValue: initialState)
        _category = State(initialValue: initialState == "interrupted" ? .recovery : .saved)
    }
    var body: some View {
        NavigationStack {
            List {
                if category == .history {
                    Section("Agent conversations") {
                        NavigationLink("Hibernating conversations (\(filteredSleeping.count))") {
                            AgentHistoryView(server: server, sessions: filteredSleeping, sleeping: true, preferences: preferences, open: finish)
                        }
                        NavigationLink("Conversation history (\(filteredHistory.count))") {
                            AgentHistoryView(server: server, sessions: filteredHistory, sleeping: false, preferences: preferences, open: finish)
                        }
                    }
                } else {
                if let failure { ErrorRow(message: failure) { Task { await load() } } }
                ForEach(sessions) { saved in
                    VStack(alignment: .leading, spacing: 10) {
                        Button { detail = saved } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                HStack(spacing: 8) {
                                    HarnessIcon(agent: saved.agentType)
                                    Text(saved.name).font(.headline).foregroundStyle(.primary)
                                    if saved.pinned { Image(systemName: "pin.fill").font(.caption).accessibilityLabel("Pinned") }
                                }
                                Text(saved.state.capitalized)
                                    .font(.caption).foregroundStyle(.secondary)
                                if preferences.bool("showProjectName", true), !saved.projectPath.isEmpty {
                                    ProjectChip(name: URL(fileURLWithPath: saved.projectPath).lastPathComponent)
                                }
                                if let error = saved.error { Text(error).font(.callout).foregroundStyle(.primary) }
                            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(resuming != nil).accessibilityIdentifier("saved-\(saved.name)")
                        if category == .recovery {
                            if dynamicTypeSize.isAccessibilitySize {
                                VStack(alignment: .leading, spacing: 12) { recoveryActions(saved) }
                            } else {
                                HStack { recoveryActions(saved) }
                            }
                        }
                    }
                    .padding(14).nativeGlassSurface()
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                if loading { ProgressView("Loading library…") }
                if sessions.isEmpty && !loading && failure == nil { ContentUnavailableView(hasFilters ? "No matching sessions" : category == .recovery ? "Nothing to recover" : "No saved sessions", systemImage: "clock", description: Text(hasFilters ? "Change your search or clear Library filters." : category == .recovery ? "Interrupted sessions will appear here. Your other saved sessions are under Saved." : "Saved sessions will appear here.")) }
                if cursor != nil { Button("Load more") { Task { await load(more: true) } }.disabled(loading) }

                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                Picker("Library category", selection: $category) {
                    ForEach(Category.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).disabled(resuming != nil).padding(.horizontal, 16).padding(.vertical, 8)
                    .background(.bar).accessibilityIdentifier("library-category")
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Library").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: category == .history ? "Search conversations" : "Search saved sessions")
            .onSubmit(of: .search) { Task { await load() } }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(300))
                if !Task.isCancelled { await load() }
            }
            .onChange(of: category) { _, value in
                sessions = []; cursor = nil; failure = nil
                if value == .recovery { state = "interrupted" }
                else if value == .saved { state = "all" }
                Task { await load() }
            }
            .onChange(of: state) { _, _ in Task { await load() } }
            .onChange(of: pinned) { _, _ in Task { await load() } }
            .onChange(of: board.libraryVersion) { _, _ in Task { await load() } }
            .refreshable { await load() }
            .task { await load() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(resuming != nil) }
                if category != .history {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Library filters", systemImage: "line.3.horizontal.decrease") { showFilters = true }
                    }
                }
            }
            .interactiveDismissDisabled(resuming != nil)
            .sheet(isPresented: $showFilters) {
                NavigationStack {
                    Form {
                        if category == .saved {
                            Picker("State", selection: $state) {
                                Text("All").tag("all"); Text("Hibernating").tag("hibernating")
                                Text("Recovery").tag("interrupted"); Text("Archived").tag("archived")
                                Text("Failed").tag("failed"); Text("Running").tag("running")
                            }
                        }
                        Toggle("Pinned only", isOn: $pinned)
                    }.navigationTitle("Library filters").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showFilters = false } } }
                }.presentationDetents([.medium, .large])
            }
            .sheet(item: $detail) { saved in SavedDetailView(server: server, saved: saved, open: finish) }
        }
    }
    private var hasFilters: Bool { !query.isEmpty || pinned || (category == .saved && state != "all") }
    @ViewBuilder private func recoveryActions(_ saved: SavedSession) -> some View {
        Button { resume(saved) } label: {
            Text(resuming == saved.id ? "Resuming…" : "Resume session")
                .fixedSize(horizontal: false, vertical: true)
        }.buttonStyle(.borderedProminent).disabled(resuming != nil)
        Button("Details") { detail = saved }.buttonStyle(.borderless).disabled(resuming != nil)
    }
    private func resume(_ saved: SavedSession) {
        guard resuming == nil else { return }
        resuming = saved.id
        Task {
            defer { resuming = nil }
            do {
                let session: RemoteSession = try await BoardAPI(server).request("api/library/\(saved.id)/resume", method: "POST", body: ["operationId": UUID().uuidString])
                finish(session.boardSession)
            } catch { failure = error.localizedDescription }
        }
    }
    private var filteredSleeping: [AgentLogSession] { matchingConversations(conversations.snapshot.sleeping) }
    private var filteredHistory: [AgentLogSession] { matchingConversations(conversations.snapshot.history) }
    private func matchingConversations(_ values: [AgentLogSession]) -> [AgentLogSession] {
        selection.conversations(values).filter { query.isEmpty || "\($0.displayName) \($0.projectPath)".localizedCaseInsensitiveContains(query) }
    }
    private var selection: CatalogSelection { CatalogSelection(projects: preferences.strings("projectFilters"), hosts: preferences.strings("hostFilters")) }
    private func finish(_ session: BoardSession) { dismiss(); open(session) }
    private func load(more: Bool = false) async {
        guard category != .history, !loading else { return }; loading = true
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
                Section {
                    Text(detail?.session.name ?? saved.name).font(.headline)
                    Text(detail?.session.state.capitalized ?? saved.state.capitalized).font(.subheadline).foregroundStyle(.secondary)
                    Button { resume() } label: {
                        Text("Resume session").fixedSize(horizontal: false, vertical: true)
                    }.buttonStyle(.borderedProminent).disabled(busy)
                }
                Section("Manage session") {
                    DisclosureGroup("Rename session") {
                        TextField("Name", text: $name)
                        Button("Save name") { update(["name": name]) }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                    }
                    Button((detail?.session.pinned ?? saved.pinned) ? "Unpin" : "Pin", systemImage: "pin") {
                        update(["pinned": !(detail?.session.pinned ?? saved.pinned)])
                    }.disabled(busy)
                    if (detail?.session.state ?? saved.state) != "archived" {
                        Button("Archive session", role: .destructive) { confirmArchive = true }.disabled(busy)
                    }
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
                    Section {
                        DisclosureGroup("Details & lifecycle events") {
                        Text(saved.projectPath).textSelection(.enabled)
                        ForEach(detail.events) { event in VStack(alignment: .leading) {
                            Text(event.kind); Text(event.createdAt).font(.caption).foregroundStyle(.secondary)
                            if let detail = event.detail { Text(detail).font(.caption).textSelection(.enabled) }
                        } }
                        }
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
                    NavigationLink {
                        TranscriptView(server: server, sessionID: session.id, title: session.displayName)
                    } label: {
                        HStack(spacing: 8) {
                            HarnessIcon(agent: session.agentType)
                            Text(renamed[session.id] ?? session.displayName)
                        }
                    }
                    if preferences.bool("showProjectName", true), !session.projectPath.isEmpty {
                        ProjectChip(name: URL(fileURLWithPath: session.projectPath).lastPathComponent)
                    }
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
