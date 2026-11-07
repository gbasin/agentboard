import SwiftUI

struct BoardSession: Identifiable, Hashable {
    let id: String
    var name: String
    let project: String
    let agent: String
    var status: Status
    let summary: String
    var host: String? = nil
    var remote = false
    var source: String? = nil
    var boardID: String? = nil
    var agentSessionID: String? = nil
    var command: String? = nil
    var createdAt: String = ""
    var lastActivity: String = ""
    var media: [MediaItem] = []
    var prs: [PullRequestItem] = []

    var orderKey: String {
        let agentID = agentSessionID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return agentID.isEmpty ? id : agentID
    }

    enum Status: String, CaseIterable {
        case working = "Working", waiting = "Waiting", sleeping = "Sleeping", permission = "Permission", unknown = "Unknown"
        init(wireValue: String) {
            switch wireValue {
            case "working": self = .working
            case "waiting": self = .waiting
            case "permission": self = .permission
            default: self = .unknown
            }
        }
        var color: Color {
            switch self {
            case .working: .green
            case .waiting, .permission: .orange
            case .sleeping, .unknown: .secondary
            }
        }
        var symbol: String {
            switch self {
            case .working: "circle.fill"
            case .waiting: "hand.raised.fill"
            case .sleeping: "moon.fill"
            case .permission: "lock.fill"
            case .unknown: "questionmark.circle"
            }
        }
    }

    static let samples: [BoardSession] = [
        .init(id: "pure-pod-2", name: "pure-pod-2", project: "agentboard", agent: "Codex", status: .working,
              summary: "Explore a native iPhone interface"),
        .init(id: "terminal-input", name: "terminal-input", project: "agentboard", agent: "Claude", status: .waiting,
              summary: "Ready to review keyboard handling"),
        .init(id: "session-search", name: "session-search", project: "agentboard", agent: "Codex", status: .working,
              summary: "Improve session search and filtering"),
        .init(id: "docs", name: "getting-started", project: "agentboard", agent: "Claude", status: .sleeping,
              summary: "Update the setup guide")
    ]
}

struct SessionStatus: View {
    let status: BoardSession.Status
    var body: some View {
        Label { Text(status.rawValue).foregroundStyle(.primary) } icon: {
            Image(systemName: status.symbol).foregroundStyle(status.color)
        }
        .labelStyle(.titleAndIcon)
        .font(.caption)
    }
}
