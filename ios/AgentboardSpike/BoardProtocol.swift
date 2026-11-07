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
    let isHibernating: Bool?

    var boardSession: BoardSession {
        .init(id: id, name: name, project: projectPath, agent: agentType ?? "Shell",
              status: isHibernating == true ? .sleeping : BoardSession.Status(wireValue: status),
              summary: lastUserMessage ?? "", host: host, remote: remote ?? false)
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

    private enum CodingKeys: String, CodingKey {
        case type, sessions, session, sessionId, data, message, remoteAllowAttach, retryable, seq
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decode(String.self, forKey: .type)
        // Other events reuse "session" for AgentSession, a different schema.
        // Decode only the payload for the event we actually consume.
        sessions = type == "sessions" ? try values.decode([RemoteSession].self, forKey: .sessions) : nil
        session = ["session-created", "session-update"].contains(type)
            ? try values.decode(RemoteSession.self, forKey: .session) : nil
        sessionId = ["session-removed", "terminal-output", "terminal-ready", "terminal-error", "kill-failed"].contains(type)
            ? try values.decodeIfPresent(String.self, forKey: .sessionId) : nil
        data = type == "terminal-output" ? try values.decode(String.self, forKey: .data) : nil
        message = ["terminal-error", "error", "kill-failed"].contains(type) ? try values.decodeIfPresent(String.self, forKey: .message) : nil
        remoteAllowAttach = type == "server-config" ? try values.decodeIfPresent(Bool.self, forKey: .remoteAllowAttach) : nil
        retryable = type == "terminal-error" ? try values.decodeIfPresent(Bool.self, forKey: .retryable) : nil
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
