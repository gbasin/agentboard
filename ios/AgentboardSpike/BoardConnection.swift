import SwiftUI

/// Dormant conversation updates notify only views that display that catalog.
@MainActor
final class AgentConversationCatalog: ObservableObject {
    struct Snapshot: Equatable {
        let sleeping: [AgentLogSession]
        let history: [AgentLogSession]
    }
    @Published private(set) var snapshot = Snapshot(sleeping: [], history: [])

    func replace(sleeping: [AgentLogSession], history: [AgentLogSession]) {
        let next = Snapshot(sleeping: sleeping, history: history)
        if snapshot != next { snapshot = next }
    }
}

/// One socket owns the catalog and the visible terminal. Every async callback is
/// scoped to a connection generation; disconnected keystrokes are never queued.
@MainActor
final class BoardConnection: ObservableObject {
    enum State: Equatable {
        case disconnected, connecting, connected, suspended, retrying(String), failed(String)
        var label: String {
            switch self {
            case .disconnected: "Not connected"
            case .connecting: "Connecting…"
            case .connected: "Connected"
            case .suspended: "Paused in background"
            case .retrying(let reason): "Reconnecting · \(reason)"
            case .failed(let reason): reason
            }
        }
    }
    enum TerminalState: Equatable {
        case waiting, attaching, ready, unavailable(String)
        var label: String {
            switch self {
            case .waiting: "Waiting for connection…"
            case .attaching: "Opening terminal…"
            case .ready: "Connected"
            case .unavailable(let reason): reason
            }
        }
    }
    private struct Target {
        let sessionID: String
        let owner: UUID
        var size: TerminalSize
        let output: (String) -> Void
        let reset: () -> Void
        let status: (TerminalState) -> Void
    }
    private let snapshotRequest = TerminalSnapshotRequest()
    var terminalColumns: Int { target?.size.cols ?? 80 }
    func captureSnapshot(sessionID: String) async throws -> TerminalSnapshotReply {
        guard state == .connected, target?.sessionID == sessionID, terminalState == .ready else { throw SessionActionError(message: "Reconnect to the terminal before selecting text.") }
        return try await snapshotRequest.capture(session: sessionID) { id in
            enqueue(["type": "terminal-snapshot-request", "sessionId": sessionID, "requestId": id])
        }
    }
    let preferences: NativePreferences
    @Published private(set) var hosts: [HostState] = []
    let conversations = AgentConversationCatalog()
    @Published private(set) var libraryVersion = 0
    @Published var clipboardOffer: String?
    @Published private(set) var inCopyMode = false
    @Published private(set) var remoteAllowControl = false
    @Published private(set) var sessions: [BoardSession] = []
    @Published private(set) var state: State = .disconnected
    @Published private(set) var remoteAllowAttach = false
    private(set) var terminalState: TerminalState = .waiting
    private var address: ServerAddress?
    private var socket: BoardSocket?
    private var generation = UUID()
    private var target: Target?
    private var receiver: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var retryCount = 0
    private var pingSequence = 0
    private var awaitingPong: Int?
    private let makeSocket: (URL) -> BoardSocket

    init(preferences: NativePreferences? = nil, makeSocket: @escaping (URL) -> BoardSocket = { URLBoardSocket(url: $0) }) {
        self.preferences = preferences ?? NativePreferences()
        self.makeSocket = makeSocket
    }
    func configure(_ value: String) {
        stopSocket()
        preferences.serverURL = value; preferences.shared = [:]; preferences.error = nil
        conversations.replace(sleeping: [], history: [])
        hosts = []; clipboardOffer = nil; inCopyMode = false; remoteAllowControl = false
        sessions = []
        target = nil
        address = nil
        remoteAllowAttach = false
        retryCount = 0
        guard !value.isEmpty else { state = .disconnected; return }
        do { address = try ServerAddress(value); connect() }
        catch { state = .failed(error.localizedDescription) }
    }
    func reconnect() {
        guard address != nil else { return }
        retryCount = 0
        connect()
    }
    func suspend() {
        guard address != nil else { return }
        stopSocket()
        state = .suspended
    }
    func resume() {
        if address != nil && state == .suspended { connect() }
    }
    func refresh() {
        if state == .connected { enqueue(["type": "session-refresh"]) }
        else { reconnect() }
    }
    func canOpen(_ session: BoardSession) -> Bool {
        session.status != .sleeping && (!session.remote || remoteAllowAttach)
    }
    func select(_ id: String, owner: UUID, size: TerminalSize,
                output: @escaping (String) -> Void, reset: @escaping () -> Void,
                status: @escaping (TerminalState) -> Void) {
        if let old = target, state == .connected {
            enqueue(["type": "terminal-detach", "sessionId": old.sessionID])
        }
        clipboardOffer = nil; inCopyMode = false
        target = Target(sessionID: id, owner: owner, size: size, output: output, reset: reset, status: status)
        setTerminalState(.waiting)
        // The protocol has no attachment ID. A fresh socket prevents late
        // output/ready messages for a previous visit to this same session from
        // being mistaken for this attachment.
        if state == .connected { connect() }
    }
    func deselect(owner: UUID) {
        guard let old = target, old.owner == owner else { return }
        if state == .connected { enqueue(["type": "terminal-detach", "sessionId": old.sessionID]) }
        snapshotRequest.cancel()
        target = nil
        clipboardOffer = nil; inCopyMode = false
        terminalState = .waiting
    }
    func resize(_ size: TerminalSize, owner: UUID) {
        guard var current = target, current.owner == owner, current.size != size else { return }
        current.size = size
        target = current
        if state == .connected && terminalState == .ready {
            enqueue(["type": "terminal-resize", "sessionId": current.sessionID, "cols": size.cols, "rows": size.rows])
        }
    }
    func input(_ value: String, owner: UUID, paste: Bool = false, scroll: Bool = false) {
        guard state == .connected, terminalState == .ready, let current = target, current.owner == owner else { return }
        // Typing with the keyboard already open must leave history first.
        // Wheel input must stay in copy mode so successive swipes keep scrolling.
        if scroll { inCopyMode = true }
        else if inCopyMode { exitCopyMode() }
        enqueue(["type": paste ? "terminal-paste" : "terminal-input", "sessionId": current.sessionID, "data": value])
    }
    func exitCopyMode() {
        if let target, state == .connected {
            enqueue(["type": "tmux-cancel-copy-mode", "sessionId": target.sessionID])
            inCopyMode = false
        }
    }
    private func setTerminalState(_ value: TerminalState) {
        terminalState = value
        target?.status(value)
    }
    private func connect() {
        guard let address else { return }
        stopSocket()
        state = .connecting
        remoteAllowAttach = false
        let epoch = generation
        let connection = makeSocket(address.socketURL)
        socket = connection
        receiver = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let text = try await connection.receive()
                    guard let self, self.generation == epoch else { return }
                    let event = try JSONDecoder().decode(BoardEvent.self, from: Data(text.utf8))
                    self.handle(event)
                }
            } catch {
                guard let self, self.generation == epoch else { return }
                self.connectionFailed(error.localizedDescription)
            }
        }
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self, self.generation == epoch else { return }
                self.pingSequence += 1
                self.awaitingPong = self.pingSequence
                self.enqueue(["type": "ping", "seq": self.pingSequence])
                do { try await Task.sleep(for: .seconds(8)) } catch { return }
                guard self.generation == epoch else { return }
                if self.awaitingPong != nil { self.connectionFailed("Server did not respond"); return }
            }
        }
    }
    private func attach() {
        guard let current = target else { return }
        guard let session = sessions.first(where: { $0.id == current.sessionID }) else {
            setTerminalState(.unavailable("This session is no longer available.")); return
        }
        guard canOpen(session) else {
            setTerminalState(.unavailable(session.status == .sleeping ? "Wake this session in Agentboard first." : "This remote session is read-only.")); return
        }
        current.reset()
        setTerminalState(.attaching)
        enqueue(["type": "terminal-attach", "sessionId": current.sessionID,
                 "cols": current.size.cols, "rows": current.size.rows])
    }
    private func handle(_ event: BoardEvent) {
        switch event.type {
        case "terminal-snapshot": if let reply = event.snapshot { snapshotRequest.receive(reply) }
        case "synced-settings": if let settings = event.settings { preferences.shared = settings }
        case "host-status": hosts = event.hosts ?? []
        case "agent-sessions": conversations.replace(sleeping: event.hibernating ?? [], history: event.history ?? [])
        case "library-changed": libraryVersion += 1
        case "clipboard-offer": if event.sessionId == target?.sessionID { clipboardOffer = event.clipboard }
        case "tmux-copy-mode-status": if event.sessionId == target?.sessionID { inCopyMode = event.inCopyMode ?? false }
        case "sessions":
            guard let items = event.sessions else { return }
            sessions = items.map(\.boardSession)
            let wasConnected = state == .connected
            state = .connected
            retryCount = 0
            if !wasConnected { attach() }
            else { checkTargetExists() }
        case "session-update", "session-created":
            guard let item = event.session?.boardSession else { return }
            if let index = sessions.firstIndex(where: { $0.id == item.id }) {
                let previous = sessions[index].status
                if item.status == .permission && previous != .permission && preferences.bool("soundOnPermission") { NativePreferences.sound(permission: true) }
                if item.status == .waiting && previous == .working && preferences.bool("soundOnIdle") { NativePreferences.sound(permission: false) }
                sessions[index] = item
            }
            else { sessions.append(item) }
            checkTargetExists()
        case "session-removed":
            sessions.removeAll { $0.id == event.sessionId }
            checkTargetExists()
        case "server-config":
            remoteAllowAttach = event.remoteAllowAttach ?? false
            remoteAllowControl = event.remoteAllowControl ?? false
            if terminalState != .ready && terminalState != .attaching && state == .connected { attach() }
        case "terminal-output":
            if event.sessionId == target?.sessionID, let data = event.data,
               terminalState == .attaching || terminalState == .ready { target?.output(data) }
        case "terminal-ready":
            if event.sessionId == target?.sessionID && terminalState == .attaching {
                setTerminalState(.ready)
                if let current = target {
                    enqueue(["type": "terminal-resize", "sessionId": current.sessionID,
                             "cols": current.size.cols, "rows": current.size.rows])
                }
            }
        case "terminal-error":
            if event.sessionId == nil || event.sessionId == target?.sessionID {
                setTerminalState(.unavailable(event.message ?? "Could not open terminal."))
            }
        case "pong":
            if event.seq == awaitingPong { awaitingPong = nil }
        case "error":
            let reason = event.message ?? "Server error"
            if state != .connected {
                stopSocket()
                state = .failed(reason)
            }
            setTerminalState(.unavailable(reason))
        default: break
        }
    }
    private func checkTargetExists() {
        guard let current = target else { return }
        guard let session = sessions.first(where: { $0.id == current.sessionID }), canOpen(session) else {
            if terminalState == .ready || terminalState == .attaching {
                enqueue(["type": "terminal-detach", "sessionId": current.sessionID])
                setTerminalState(.unavailable("This session is no longer available to attach."))
            }
            return
        }
    }
    private func enqueue(_ payload: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        let epoch = generation
        let previous = sender
        sender = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, let self, self.generation == epoch else { return }
            do { try await socket.send(text) }
            catch { if self.generation == epoch { self.connectionFailed(error.localizedDescription) } }
        }
    }
    private func connectionFailed(_ reason: String) {
        stopSocket()
        state = .retrying(reason)
        retryCount += 1
        let delay = min(15, 1 << min(retryCount - 1, 4))
        let epoch = generation
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.generation == epoch else { return }
            self.connect()
        }
    }
    private func stopSocket() {
        snapshotRequest.cancel()
        generation = UUID()
        receiver?.cancel(); receiver = nil
        heartbeat?.cancel(); heartbeat = nil
        reconnectTask?.cancel(); reconnectTask = nil
        sender?.cancel(); sender = nil
        socket?.close(); socket = nil
        awaitingPong = nil
        setTerminalState(.waiting)
    }
}
