import SwiftUI

/// Shared project/host choices include dormant sessions and retained selections.
struct CatalogFilters: View {
    @ObservedObject var preferences: NativePreferences
    let sessions: [BoardSession]
    @ObservedObject var conversations: AgentConversationCatalog
    private var conversationSessions: [AgentLogSession] { conversations.snapshot.sleeping + conversations.snapshot.history }
    var hosts: [HostState] = []
    @Binding var status: String
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss
    private var projects: [String] {
        CatalogSelection.choices(sessions.map(\.project) + conversationSessions.map(\.projectPath), selected: preferences.strings("projectFilters"), query: query)
    }
    private var hostNames: [String] {
        CatalogSelection.choices(sessions.map { $0.host ?? "" } + conversationSessions.map { $0.host ?? "" } + hosts.map(\.host), selected: preferences.strings("hostFilters"), query: query)
    }
    var body: some View {
        NavigationStack {
            Form {
                if let error = preferences.error { ErrorRow(message: error) }
                if preferences.saving { ProgressView("Saving filters…") }
                Section("Status") {
                    Picker("Status", selection: $status) {
                        Text("All").tag("All")
                        ForEach(BoardSession.Status.allCases, id: \.self) { Text($0.rawValue).tag($0.rawValue) }
                    }
                }
                Section("Order") {
                    Picker("Sort", selection: preferences.selection("sessionSortMode", fallback: "created")) {
                        Text("Created").tag("created"); Text("Needs attention").tag("status"); Text("Manual").tag("manual")
                    }
                    Picker("Direction", selection: preferences.selection("sessionSortDirection", fallback: "desc")) {
                        Text("Newest first").tag("desc"); Text("Oldest first").tag("asc")
                    }.disabled(preferences.string("sessionSortMode", "created") != "created")
                }
                if !projects.isEmpty { Section("Projects · none selected means all") {
                    ForEach(projects, id: \.self) { path in check(path, key: "projectFilters") }
                } }
                if !hostNames.isEmpty { Section("Hosts · none selected means all") {
                    ForEach(hostNames, id: \.self) { host in
                        check(host, key: "hostFilters", hostState: hosts.first { $0.host == host })
                    }
                } }
                if projects.isEmpty && hostNames.isEmpty { Text("No matching projects or hosts").foregroundStyle(.secondary) }
                Button("Clear filters") { status = "All"; preferences.set("projectFilters", .array([])); preferences.set("hostFilters", .array([])) }
            }
            .searchable(text: $query, prompt: "Find projects or hosts")
            .navigationTitle("Filter and sort").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
    private func check(_ value: String, key: String, hostState: HostState? = nil) -> some View {
        Toggle(isOn: Binding(get: { preferences.strings(key).contains(value) }, set: { enabled in
            var items = preferences.strings(key).filter { $0 != value }; if enabled { items.append(value) }
            preferences.set(key, .array(items.map(JSONValue.string)))
        })) {
            VStack(alignment: .leading, spacing: 4) {
                Text(value.isEmpty ? "Local" : value)
                if let hostState, !hostState.ok {
                    Label("Offline", systemImage: "wifi.exclamationmark").font(.caption)
                    if let error = hostState.error { Text(error).font(.caption).foregroundStyle(.secondary) }
                }
            }
        }.disabled(preferences.saving).accessibilityIdentifier("filter-\(key)-\(value)")
    }
}
