import SwiftUI

/// Exact optional catalog payload from src/shared/activity.ts (subagent-activity backend).
/// Missing activity means unsupported/unavailable, never zero active children.
struct NativeSessionActivity: Decodable, Hashable {
    struct Observation: Decodable, Hashable {
        let phase: String
        let label: String
        let updatedAt: String?
        let tools: [String]
    }
    struct Child: Decodable, Hashable, Identifiable {
        let id: String
        let name: String
        let activity: Observation
    }
    let main: Observation
    let subagents: [Child]
    let running: Int
    let unknown: Int
    let blocked: Int
    let total: Int
    let truncated: Bool

    var summary: String {
        var parts = ["\(running) running"]
        if blocked > 0 { parts.append("\(blocked) awaiting input") }
        if unknown > 0 { parts.append("\(unknown) unknown") }
        parts.append("\(total) total")
        return parts.joined(separator: " · ")
    }
}

/// Parent supplies the current catalog session so socket observations update an open sheet.
struct NativeSubagentActivityView: View {
    let session: BoardSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let activity = session.activity {
                    Section {
                        observation("Main session", activity.main,
                                    override: session.status == .permission ? "Needs input (terminal signal)" : nil)
                    } header: { Text(session.name) }
                    Section {
                        ForEach(activity.subagents) { child in observation(child.name, child.activity) }
                        if activity.total == 0 { Text("No subagents reported").foregroundStyle(.secondary) }
                        if activity.truncated {
                            Text("Showing \(activity.subagents.count) of \(activity.total) subagents. Uninspected activity is unknown.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    } header: { Text(activity.summary) } footer: {
                        Text("From logs. Pending tools may await approval. Silence for 15 minutes means unknown.")
                    }
                } else {
                    ContentUnavailableView("Activity unavailable", systemImage: "person.2",
                                           description: Text("This server has not supplied agent activity for this session."))
                }
            }
            .navigationTitle("Agent activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func observation(_ name: String, _ value: NativeSessionActivity.Observation, override: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(name).font(.headline)
            Text(override ?? value.label).font(.subheadline)
            if value.phase == "blocked" { Label("Awaiting input", systemImage: "hand.raised").font(.caption) }
            if !value.tools.isEmpty { Text(value.tools.joined(separator: ", ")).font(.caption.monospaced()).foregroundStyle(.secondary) }
            if let date = value.updatedAt.flatMap(BoardSession.activityDate) {
                Text("Last signal \(date.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 4)
    }
}
