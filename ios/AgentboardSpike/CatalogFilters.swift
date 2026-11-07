import SwiftUI

struct CatalogFilters: View {
    @ObservedObject var preferences: NativePreferences
    let sessions: [BoardSession]
    @Binding var status: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                if let error = preferences.error { ErrorRow(message: error) }
                Section("Status") {
                    Picker("Status", selection: $status) {
                        Text("All").tag("All")
                        ForEach(BoardSession.Status.allCases, id: \.self) { Text($0.rawValue).tag($0.rawValue) }
                    }
                }
                Section("Order") {
                    Picker("Sort", selection: preferences.selection("sessionSortMode", fallback: "created")) {
                        Text("Created").tag("created"); Text("Status").tag("status"); Text("Manual").tag("manual")
                    }
                    Picker("Direction", selection: preferences.selection("sessionSortDirection", fallback: "desc")) {
                        Text("Newest first").tag("desc"); Text("Oldest first").tag("asc")
                    }
                }
                Section("Projects · none selected means all") {
                    ForEach(Array(Set(sessions.map(\.project))).sorted(), id: \.self) { path in check(path, key: "projectFilters") }
                }
                Section("Hosts · none selected means all") {
                    ForEach(Array(Set(sessions.map { $0.host ?? "" })).sorted(), id: \.self) { host in check(host, key: "hostFilters") }
                }
                Button("Clear filters") { status = "All"; preferences.set("projectFilters", .array([])); preferences.set("hostFilters", .array([])) }
            }.navigationTitle("Filter and sort").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
    private func check(_ value: String, key: String) -> some View {
        Toggle(value.isEmpty ? "Local" : value, isOn: Binding(get: { preferences.strings(key).contains(value) }, set: { enabled in
            var items = preferences.strings(key).filter { $0 != value }; if enabled { items.append(value) }
            preferences.set(key, .array(items.map(JSONValue.string)))
        }))
    }
}
