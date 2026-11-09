import XCTest
import Combine
@testable import AgentboardSpike

@MainActor
final class BoardConnectionTests: XCTestCase {
    final class Socket: BoardSocket {
        var sent: [[String: Any]] = []
        var pending: CheckedContinuation<String, Error>?
        var queued: [String] = []
        var closed = false
        func receive() async throws -> String {
            if !queued.isEmpty { return queued.removeFirst() }
            return try await withCheckedThrowingContinuation { pending = $0 }
        }
        func send(_ text: String) async throws {
            sent.append(try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any])
        }
        func close() { closed = true }
        func emit(_ value: String) {
            if let pending { self.pending = nil; pending.resume(returning: value) }
            else { queued.append(value) }
        }
        func finish() { pending?.resume(throwing: URLError(.cancelled)); pending = nil }
        var types: [String] { sent.compactMap { $0["type"] as? String } }
    }
    let snapshot = #"{"type":"sessions","sessions":[{"id":"one","name":"One","projectPath":"/tmp/test","status":"working","source":"managed"}]}"#
    func settle() async { for _ in 0..<20 { await Task.yield() } }

    func testConversationUpdatesNotifyOnlyCatalogAndResetWithServer() async {
        var sockets: [Socket] = []
        let board = BoardConnection { _ in let socket = Socket(); sockets.append(socket); return socket }
        defer { board.suspend(); sockets.forEach { $0.finish() } }
        board.configure("http://localhost:4040")
        sockets[0].emit(snapshot)
        await settle()
        var boardChanges = 0
        var catalogSnapshots: [AgentConversationCatalog.Snapshot] = []
        let boardSubscription = board.objectWillChange.sink { boardChanges += 1 }
        let catalogSubscription = board.conversations.$snapshot.dropFirst().sink { catalogSnapshots.append($0) }
        defer { boardSubscription.cancel(); catalogSubscription.cancel() }
        let dormant = #"{"type":"agent-sessions","hibernating":[{"sessionId":"log","displayName":"Sleeping","agentType":"claude","projectPath":"/tmp","createdAt":"","lastActivityAt":"","isHibernating":true}],"history":[]}"#
        sockets[0].emit(dormant)
        await settle()
        XCTAssertEqual(catalogSnapshots.count, 1)
        XCTAssertEqual(catalogSnapshots.last?.sleeping.first?.id, "log")
        XCTAssertEqual(boardChanges, 0, "Dormant conversations must not rebuild the live board's native menus")
        sockets[0].emit(dormant)
        await settle()
        XCTAssertEqual(catalogSnapshots.count, 1, "Repeated snapshots must not notify catalog views")
        XCTAssertEqual(boardChanges, 0)
        // Move the conversation into history with an explicit protocol event.
        sockets[0].emit(#"{"type":"agent-sessions","hibernating":[],"history":[{"sessionId":"log","displayName":"Sleeping","agentType":"claude","projectPath":"/tmp","createdAt":"","lastActivityAt":"","isHibernating":true}]}"#)
        await settle()
        XCTAssertEqual(catalogSnapshots.count, 2)
        XCTAssertTrue(board.conversations.snapshot.sleeping.isEmpty)
        XCTAssertEqual(board.conversations.snapshot.history.first?.id, "log")
        XCTAssertEqual(boardChanges, 0)
        sockets[0].emit(#"{"type":"session-update","session":{"id":"one","name":"Updated","projectPath":"/tmp/test","status":"waiting","source":"managed"}}"#)
        await settle()
        XCTAssertGreaterThan(boardChanges, 0, "Live session changes must still notify the board")
        XCTAssertEqual(board.sessions.first?.name, "Updated")
        XCTAssertEqual(catalogSnapshots.count, 2)
        board.configure("http://localhost:5050")
        XCTAssertEqual(catalogSnapshots.count, 3)
        XCTAssertTrue(board.conversations.snapshot.sleeping.isEmpty)
        XCTAssertTrue(board.conversations.snapshot.history.isEmpty)
    }

    func testTransportFailureReconnectsAutomatically() async throws {
        var sockets: [Socket] = []
        let board = BoardConnection { _ in let socket = Socket(); sockets.append(socket); return socket }
        defer { board.suspend(); sockets.forEach { $0.finish() } }
        board.configure("http://localhost:4040")
        let owner = UUID()
        board.select("one", owner: owner, size: .init(cols: 40, rows: 20), output: { _ in }, reset: {}, status: { _ in })
        sockets[0].emit(snapshot)
        sockets[0].emit(#"{"type":"terminal-ready","sessionId":"one"}"#)
        await settle()
        sockets[0].finish()
        await settle()
        if case .retrying = board.state {} else { XCTFail("Expected reconnect backoff") }
        board.input("do-not-replay", owner: owner)
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertEqual(sockets.count, 2)
        sockets[1].emit(snapshot)
        await settle()
        XCTAssertEqual(sockets[1].types, ["terminal-attach"])
        XCTAssertEqual(board.terminalState, .attaching)
    }

    func testServerRejectionIsVisibleInCatalog() async {
        let socket = Socket()
        let board = BoardConnection { _ in socket }
        board.configure("http://localhost:4040")
        socket.emit(#"{"type":"error","message":"Client protocol unsupported"}"#)
        await settle()
        XCTAssertEqual(board.state, .failed("Client protocol unsupported"))
        XCTAssertTrue(socket.closed)
        socket.finish()
    }

    func testAddressAndForwardCompatibleDecoding() throws {
        XCTAssertEqual(try ServerAddress(" https://host.example/prefix/ ").socketURL.absoluteString, "wss://host.example/prefix/ws?catalog=2")
        XCTAssertEqual(try ServerAddress("http://100.1.2.3:4040").socketURL.absoluteString, "ws://100.1.2.3:4040/ws?catalog=2")
        for invalid in ["", "file:///tmp/test", "ws://host", "https://user:pass@host", "https://host?a=1"] {
            XCTAssertThrowsError(try ServerAddress(invalid))
        }
        let event = try JSONDecoder().decode(BoardEvent.self, from: Data(snapshot.utf8))
        XCTAssertEqual(event.sessions?.first?.boardSession.status, .working)
        XCTAssertEqual(BoardSession.Status(wireValue: "new-server-status"), .unknown)
        let unrelated = #"{"type":"session-orphaned","session":{"sessionId":"agent-log-id","displayName":"Different schema"}}"#
        let ignored = try JSONDecoder().decode(BoardEvent.self, from: Data(unrelated.utf8))
        XCTAssertEqual(ignored.type, "session-orphaned")
        XCTAssertNil(ignored.session)
    }

    func testLiveStatusSurvivesPersistedHibernationMarker() throws {
        let live = #"{"type":"sessions","sessions":[{"id":"live","name":"Resumed","projectPath":"/tmp/test","status":"waiting","isHibernating":true,"source":"managed"}]}"#
        let event = try JSONDecoder().decode(BoardEvent.self, from: Data(live.utf8))
        let session = try XCTUnwrap(event.sessions?.first?.boardSession)
        XCTAssertEqual(session.status, .waiting)
        XCTAssertEqual(session.id, "live")
        // Dormant conversations arrive on a different event and remain available for Wake.
        let dormant = #"{"type":"agent-sessions","hibernating":[{"sessionId":"log","displayName":"Sleeping","agentType":"claude","projectPath":"/tmp","createdAt":"","lastActivityAt":"","isHibernating":true}],"history":[]}"#
        let sleeping = try JSONDecoder().decode(BoardEvent.self, from: Data(dormant.utf8))
        XCTAssertNil(sleeping.sessions)
        XCTAssertEqual(sleeping.hibernating?.first?.id, "log")
    }

    func testFreshAttachmentGatesInputAndIgnoresOldSocket() async {
        var sockets: [Socket] = []
        let board = BoardConnection { _ in let socket = Socket(); sockets.append(socket); return socket }
        defer { board.suspend(); sockets.forEach { $0.finish() } }
        board.configure("http://localhost:4040")
        sockets[0].emit(snapshot)
        await settle()
        XCTAssertEqual(board.state, .connected)
        let owner = UUID()
        var output = ""
        var resets = 0
        board.select("one", owner: owner, size: .init(cols: 44, rows: 20),
                     output: { output += $0 }, reset: { resets += 1 }, status: { _ in })
        XCTAssertEqual(sockets.count, 2)
        sockets[0].emit(#"{"type":"session-removed","sessionId":"one"}"#)
        board.input("must-not-send", owner: owner)
        sockets[1].emit(snapshot)
        await settle()
        XCTAssertEqual(board.sessions.count, 1)
        XCTAssertEqual(resets, 1)
        XCTAssertEqual(sockets[1].types, ["terminal-attach"])
        sockets[1].emit(#"{"type":"terminal-output","sessionId":"other","data":"WRONG"}"#)
        sockets[1].emit(#"{"type":"terminal-output","sessionId":"one","data":"history"}"#)
        sockets[1].emit(#"{"type":"terminal-ready","sessionId":"one"}"#)
        await settle()
        XCTAssertEqual(output, "history")
        XCTAssertEqual(board.terminalState, .ready)
        board.input("hello", owner: owner)
        board.input("line1\nline2", owner: owner, paste: true)
        await settle()
        XCTAssertEqual(sockets[1].types, ["terminal-attach", "terminal-resize", "terminal-input", "terminal-paste"])
        XCTAssertEqual(sockets[1].sent.last?["data"] as? String, "line1\nline2")
    }

    func testBackgroundResumeNeverReplaysInputAndPreservesTarget() async {
        var sockets: [Socket] = []
        let board = BoardConnection { _ in let socket = Socket(); sockets.append(socket); return socket }
        defer { board.suspend(); sockets.forEach { $0.finish() } }
        board.configure("http://localhost:4040")
        let owner = UUID()
        board.select("one", owner: owner, size: .init(cols: 40, rows: 18), output: { _ in }, reset: {}, status: { _ in })
        sockets[0].emit(snapshot)
        sockets[0].emit(#"{"type":"terminal-ready","sessionId":"one"}"#)
        await settle()
        XCTAssertEqual(board.terminalState, .ready)
        board.suspend()
        board.input("lost", owner: owner)
        board.resize(.init(cols: 50, rows: 22), owner: owner)
        board.resume()
        sockets[1].emit(snapshot)
        await settle()
        XCTAssertEqual(sockets[1].types, ["terminal-attach"])
        XCTAssertEqual(sockets[1].sent.first?["cols"] as? Int, 50)
        XCTAssertEqual(board.terminalState, .attaching)
        sockets[1].emit(#"{"type":"terminal-error","sessionId":"one","message":"No such session","retryable":false}"#)
        await settle()
        board.input("blocked", owner: owner)
        await settle()
        XCTAssertEqual(sockets[1].types, ["terminal-attach"])
        XCTAssertEqual(board.terminalState, .unavailable("No such session"))
    }

    func testStaleOwnerCannotDetachNewTargetAndRemovalStopsInput() async {
        let socket = Socket()
        let board = BoardConnection { _ in socket }
        defer { board.suspend(); socket.finish() }
        board.configure("http://localhost:4040")
        let old = UUID(), current = UUID()
        board.select("old", owner: old, size: .init(cols: 40, rows: 20), output: { _ in }, reset: {}, status: { _ in })
        board.select("one", owner: current, size: .init(cols: 40, rows: 20), output: { _ in }, reset: {}, status: { _ in })
        board.deselect(owner: old)
        socket.emit(snapshot)
        socket.emit(#"{"type":"terminal-ready","sessionId":"one"}"#)
        await settle()
        XCTAssertEqual(board.terminalState, .ready)
        socket.emit(#"{"type":"session-removed","sessionId":"one"}"#)
        await settle()
        board.input("blocked", owner: current)
        await settle()
        XCTAssertEqual(socket.types, ["terminal-attach", "terminal-resize", "terminal-detach"])
        XCTAssertTrue(board.sessions.isEmpty)
    }
    func testClipboardIsScopedToCurrentAttachment() async {
        var sockets: [Socket] = []
        let board = BoardConnection { _ in let socket = Socket(); sockets.append(socket); return socket }
        defer { board.suspend(); sockets.forEach { $0.finish() } }
        board.configure("http://localhost:4040")
        board.select("one", owner: UUID(), size: .init(cols: 40, rows: 20), output: { _ in }, reset: {}, status: { _ in })
        sockets[0].emit(snapshot)
        sockets[0].emit(#"{"type":"clipboard-offer","sessionId":"other","text":"wrong"}"#)
        await settle(); XCTAssertNil(board.clipboardOffer)
        sockets[0].emit(#"{"type":"clipboard-offer","sessionId":"one","text":"first session"}"#)
        await settle(); XCTAssertEqual(board.clipboardOffer, "first session")
        board.select("two", owner: UUID(), size: .init(cols: 40, rows: 20), output: { _ in }, reset: {}, status: { _ in })
        XCTAssertNil(board.clipboardOffer)
    }

}
