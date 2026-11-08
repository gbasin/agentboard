import Foundation

/// Wire fields shared with src/shared/types.ts. Unknown fields and events are ignored.
struct RemoteSession: Decodable {
    let id: String
    let name: String
    let projectPath: String
    let status: String
    let agentType: String?
    let lastUserMessage: String?
    let host: String?
    let remote: Bool?
    let source: String?
    let boardSessionId: String?
    let agentSessionId: String?
    let command: String?
    let createdAt: String?
    let lastActivity: String?
    let media: [MediaItem]?
    let prs: [PullRequestItem]?
    let mediaSummary: MediaCatalogSummary?
    let activity: NativeSessionActivity?

    // Live registry membership determines attachment; the stored hibernation marker can survive a wake.
    var boardSession: BoardSession {
        .init(id: id, name: name, project: projectPath, agent: agentType ?? "Shell",
              status: BoardSession.Status(wireValue: status),
              summary: lastUserMessage ?? "", host: host, remote: remote ?? false, source: source,
              boardID: boardSessionId, agentSessionID: agentSessionId, command: command,
              createdAt: createdAt ?? "", lastActivity: lastActivity ?? "", media: media ?? [], prs: prs ?? [], activity: activity, mediaSummary: mediaSummary)
    }
}

struct BoardEvent: Decodable {
    let type: String
    let sessions: [RemoteSession]?
    let session: RemoteSession?
    let sessionId: String?
    let data: String?
    let message: String?
    let remoteAllowAttach: Bool?
    let retryable: Bool?
    let seq: Int?
    let settings: [String: JSONValue]?
    let hosts: [HostState]?
    let hibernating: [AgentLogSession]?
    let history: [AgentLogSession]?
    let clipboard: String?
    let inCopyMode: Bool?
    let remoteAllowControl: Bool?
    let ok: Bool?
    let actionError: JSONValue?
    let snapshot: TerminalSnapshotReply?

    private enum CodingKeys: String, CodingKey {
        case type, sessions, session, sessionId, data, message, remoteAllowAttach, retryable, seq, settings, hosts, hibernating, history, text, inCopyMode, remoteAllowControl, ok, error
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decode(String.self, forKey: .type)
        snapshot = type == "terminal-snapshot" ? try TerminalSnapshotReply(from: decoder) : nil
        // Other events reuse "session" for AgentSession, a different schema.
        // Decode only the payload for the event we actually consume.
        sessions = type == "sessions" ? try values.decode([RemoteSession].self, forKey: .sessions) : nil
        session = ["session-created", "session-update", "session-wake-result"].contains(type)
            ? try values.decodeIfPresent(RemoteSession.self, forKey: .session) : nil
        sessionId = ["session-removed", "terminal-output", "terminal-ready", "terminal-error", "kill-failed", "session-wake-result", "session-hibernate-result", "session-move-to-history-result", "clipboard-offer", "tmux-copy-mode-status"].contains(type)
            ? try values.decodeIfPresent(String.self, forKey: .sessionId) : nil
        data = type == "terminal-output" ? try values.decode(String.self, forKey: .data) : nil
        message = ["terminal-error", "error", "kill-failed"].contains(type) ? try values.decodeIfPresent(String.self, forKey: .message) : nil
        remoteAllowAttach = type == "server-config" ? try values.decodeIfPresent(Bool.self, forKey: .remoteAllowAttach) : nil
        retryable = type == "terminal-error" ? try values.decodeIfPresent(Bool.self, forKey: .retryable) : nil
        settings = type == "synced-settings" ? try values.decodeIfPresent([String: JSONValue].self, forKey: .settings) : nil
        hosts = type == "host-status" ? try values.decodeIfPresent([HostState].self, forKey: .hosts) : nil
        hibernating = type == "agent-sessions" ? try values.decodeIfPresent([AgentLogSession].self, forKey: .hibernating) : nil
        history = type == "agent-sessions" ? try values.decodeIfPresent([AgentLogSession].self, forKey: .history) : nil
        clipboard = type == "clipboard-offer" ? try values.decodeIfPresent(String.self, forKey: .text) : nil
        inCopyMode = type == "tmux-copy-mode-status" ? try values.decodeIfPresent(Bool.self, forKey: .inCopyMode) : nil
        remoteAllowControl = type == "server-config" ? try values.decodeIfPresent(Bool.self, forKey: .remoteAllowControl) : nil
        ok = type.hasSuffix("-result") ? try values.decodeIfPresent(Bool.self, forKey: .ok) : nil
        actionError = type.hasSuffix("-result") ? try values.decodeIfPresent(JSONValue.self, forKey: .error) : nil
        seq = type == "pong" ? try values.decodeIfPresent(Int.self, forKey: .seq) : nil
    }
}

struct TerminalSize: Equatable {
    let cols: Int
    let rows: Int
    init(cols: Int, rows: Int) {
        self.cols = max(2, min(500, cols))
        self.rows = max(2, min(300, rows))
    }
}

protocol BoardSocket: AnyObject {
    func receive() async throws -> String
    func send(_ text: String) async throws
    func close()
}

final class URLBoardSocket: BoardSocket {
    private let task: URLSessionWebSocketTask
    init(url: URL) {
        task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = 16 * 1024 * 1024
        task.resume()
    }
    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let value): return value
        case .data(let value): return String(decoding: value, as: UTF8.self)
        @unknown default: throw URLError(.cannotDecodeContentData)
        }
    }
    func send(_ text: String) async throws { try await task.send(.string(text)) }
    func close() { task.cancel(with: .goingAway, reason: nil) }
}
