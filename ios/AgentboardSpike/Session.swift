import SwiftUI

struct BoardSession: Identifiable, Hashable {
    let id: String
    var name: String
    let project: String
    let agent: String
    var status: Status
    let summary: String

    enum Status: String, CaseIterable {
        case working = "Working", waiting = "Waiting", sleeping = "Sleeping"
        var color: Color {
            switch self {
            case .working: .green
            case .waiting: .orange
            case .sleeping: .secondary
            }
        }
        var symbol: String {
            switch self {
            case .working: "circle.fill"
            case .waiting: "hand.raised.fill"
            case .sleeping: "moon.fill"
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
        Label(status.rawValue, systemImage: status.symbol)
            .labelStyle(.titleAndIcon)
            .font(.caption)
            .foregroundStyle(status.color)
    }
}
