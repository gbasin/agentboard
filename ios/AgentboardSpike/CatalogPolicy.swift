import Foundation

/// Shared selection and capability rules for live and dormant session surfaces.
struct CatalogSelection {
    var projects: [String] = []
    var hosts: [String] = []

    var activeCount: Int { Set(projects).count + Set(hosts).count }
    func includes(project: String, host: String?) -> Bool {
        (projects.isEmpty || projects.contains(project)) && (hosts.isEmpty || hosts.contains(host ?? ""))
    }
    func conversations(_ sessions: [AgentLogSession]) -> [AgentLogSession] {
        sessions.filter { includes(project: $0.projectPath, host: $0.host) }
    }
    func hiddenPermissions(in sessions: [BoardSession]) -> Int {
        sessions.filter { $0.status == .permission && !includes(project: $0.project, host: $0.host) }.count
    }
    static func choices(_ discovered: [String], selected: [String], query: String) -> [String] {
        let words = query.split(whereSeparator: \.isWhitespace)
        return Set(discovered + selected).sorted().filter { value in
            selected.contains(value) || words.allSatisfy { (value.isEmpty ? "Local" : value).localizedCaseInsensitiveContains(String($0)) }
        }
    }
}

enum SessionCapabilities {
    static func canControl(_ session: BoardSession, remoteAllowed: Bool) -> Bool {
        !session.remote || (remoteAllowed && session.source == "managed")
    }
    static func canHibernate(_ session: BoardSession) -> Bool {
        !session.remote && (session.boardID != nil || (session.source == "managed" && !(session.agentSessionID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)))
    }
}
