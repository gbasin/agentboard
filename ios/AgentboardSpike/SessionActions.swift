import Foundation

/// A separate socket isolates uncorrelated action errors from terminal traffic.
/// Requests run once. A lost acknowledgement must never trigger a destructive replay.
enum SessionAction {
    case create(project: String, name: String, command: String, host: String)
    case rename(id: String, name: String)
    case end(id: String)
    case renameConversation(id: String, name: String)
    case lifecycle(type: String, id: String)

    var payload: [String: Any] {
        switch self {
        case let .create(project, name, command, host):
            var result: [String: Any] = ["type": "session-create", "projectPath": project,
                                         "operationId": UUID().uuidString]
            if !name.isEmpty { result["name"] = name }
            if !command.isEmpty { result["command"] = command }
            if !host.isEmpty { result["host"] = host }
            return result
        case let .renameConversation(id, name): return ["type": "session-rename", "sessionId": id, "newName": name]
        case let .rename(id, name): return ["type": "session-rename", "sessionId": id, "newName": name]
        case let .lifecycle(type, id): return ["type": type, "sessionId": id]
        case let .end(id): return ["type": "session-kill", "sessionId": id, "source": "terminal_confirm_modal"]
        }
    }
}

struct SessionActionError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
final class SessionActions {
    private let makeSocket: (URL) -> BoardSocket
    private let timeout: Duration
    init(timeout: Duration = .seconds(20), makeSocket: @escaping (URL) -> BoardSocket = { URLBoardSocket(url: $0) }) {
        self.timeout = timeout; self.makeSocket = makeSocket
    }

    func perform(_ action: SessionAction, at address: ServerAddress) async throws -> BoardSession? {
        let socket = makeSocket(address.socketURL)
        var sent = false
        let deadline = Task {
            try await Task.sleep(for: timeout)
            socket.close()
        }
        defer { deadline.cancel(); socket.close() }
        do {
            return try await withTaskCancellationHandler {
                while true {
                    try Task.checkCancellation()
                    let text = try await socket.receive()
                    try Task.checkCancellation()
                    let event = try JSONDecoder().decode(BoardEvent.self, from: Data(text.utf8))
                    if event.type == "error" || event.type == "kill-failed" {
                        throw SessionActionError(message: event.message ?? "The server could not complete this action.")
                    }
                    if !sent {
                        guard event.type == "sessions", let sessions = event.sessions else { continue }
                        switch action {
                        case .create, .lifecycle, .renameConversation: break
                        case let .rename(id, name):
                            guard let session = sessions.first(where: { $0.id == id }) else {
                                throw SessionActionError(message: "This session is no longer available.")
                            }
                            if session.name == name { return session.boardSession }
                        case let .end(id):
                            guard sessions.contains(where: { $0.id == id }) else { return nil }
                        }
                        let data = try JSONSerialization.data(withJSONObject: action.payload)
                        sent = true // A send failure can still mean the server received it.
                        try await socket.send(String(decoding: data, as: UTF8.self))
                        continue
                    }
                    switch action {
                    case let .renameConversation(id, name):
                        if (event.hibernating ?? []).contains(where: { $0.id == id && $0.displayName == name }) || (event.history ?? []).contains(where: { $0.id == id && $0.displayName == name }) { return nil }
                    case let .lifecycle(type, id):
                        if event.type == type + "-result", event.sessionId == id {
                            if event.ok == true { return event.session?.boardSession }
                            let message: String
                            if case .object(let fields) = event.actionError { message = fields["message"]?.string ?? "Action failed." }
                            else { message = event.actionError?.string ?? "Action failed." }
                            throw SessionActionError(message: message)
                        }
                    case .create:
                        // session-created is a direct response on the requesting socket.
                        if event.type == "session-created", let item = event.session { return item.boardSession }
                    case let .rename(id, name):
                        if let item = event.session, item.id == id, item.name == name { return item.boardSession }
                        if let item = event.sessions?.first(where: { $0.id == id && $0.name == name }) { return item.boardSession }
                    case let .end(id):
                        if event.type == "session-removed", event.sessionId == id { return nil }
                        if let items = event.sessions, !items.contains(where: { $0.id == id }) { return nil }
                    }
                }
            } onCancel: { socket.close() }
        } catch let error as SessionActionError {
            throw error
        } catch {
            throw SessionActionError(message: sent
                ? "The result could not be confirmed. Check the session list before trying again; the server may have completed the action."
                : "Could not reach the server. Check your connection and try again.")
        }
    }
}
