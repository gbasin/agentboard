import XCTest
@testable import AgentboardSpike

@MainActor
final class SessionActionsTests: XCTestCase {
    final class Socket: BoardSocket {
        var messages: [String]
        var sent: [[String: Any]] = []
        var pending: CheckedContinuation<String, Error>?
        var closed = false
        init(_ messages: [String]) { self.messages = messages }
        func receive() async throws -> String {
            if closed { throw URLError(.cancelled) }
            if !messages.isEmpty { return messages.removeFirst() }
            return try await withCheckedThrowingContinuation { pending = $0 }
        }
        func send(_ text: String) async throws {
            sent.append(try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any])
        }
        func close() { closed = true; pending?.resume(throwing: URLError(.cancelled)); pending = nil }
    }
    let snapshot = #"{"type":"sessions","sessions":[{"id":"one","name":"One","projectPath":"/tmp","status":"unknown"}]}"#
    var address: ServerAddress { try! ServerAddress("http://localhost:4151") }

    func testCreateWaitsForDirectResponseAndSendsExactlyOnce() async throws {
        let socket = Socket([snapshot,
            #"{"type":"session-update","session":{"id":"other","name":"Other","projectPath":"/tmp","status":"unknown"}}"#,
            #"{"type":"session-created","session":{"id":"new","name":"New","projectPath":"/tmp","status":"unknown"}}"#])
        let result = try await SessionActions(makeSocket: { _ in socket }).perform(
            .create(project: "/tmp", name: "New", command: "zsh", host: ""), at: address)
        XCTAssertEqual(result?.id, "new")
        XCTAssertEqual(socket.sent.count, 1)
        XCTAssertEqual(socket.sent[0]["command"] as? String, "zsh")
        XCTAssertNotNil(socket.sent[0]["operationId"])
        XCTAssertNil(socket.sent[0]["host"])
        XCTAssertTrue(socket.closed)
    }
    func testRenameRequiresMatchingIdentityAndName() async throws {
        let socket = Socket([snapshot,
            #"{"type":"session-update","session":{"id":"other","name":"Renamed","projectPath":"/tmp","status":"unknown"}}"#,
            #"{"type":"session-update","session":{"id":"one","name":"Renamed","projectPath":"/tmp","status":"unknown"}}"#])
        let result = try await SessionActions(makeSocket: { _ in socket }).perform(.rename(id: "one", name: "Renamed"), at: address)
        XCTAssertEqual(result?.id, "one")
        XCTAssertEqual(socket.sent.count, 1)
    }
    func testEndWaitsForTargetRemovalAndSurfacesRejection() async throws {
        let socket = Socket([snapshot, #"{"type":"session-removed","sessionId":"other"}"#,
                             #"{"type":"session-removed","sessionId":"one"}"#])
        let result = try await SessionActions(makeSocket: { _ in socket }).perform(.end(id: "one"), at: address)
        XCTAssertNil(result)
        XCTAssertEqual(socket.sent.count, 1)
        let rejected = Socket([snapshot, #"{"type":"kill-failed","sessionId":"one","message":"Remote sessions are read-only"}"#])
        do {
            _ = try await SessionActions(makeSocket: { _ in rejected }).perform(.end(id: "one"), at: address)
            XCTFail("Expected server rejection")
        } catch { XCTAssertEqual(error.localizedDescription, "Remote sessions are read-only") }
    }
    func testTimeoutDoesNotReplayAndReportsUncertainOutcome() async {
        let socket = Socket([snapshot])
        do {
            _ = try await SessionActions(timeout: .milliseconds(20), makeSocket: { _ in socket })
                .perform(.create(project: "/tmp", name: "", command: "zsh", host: ""), at: address)
            XCTFail("Expected timeout")
        } catch { XCTAssertTrue(error.localizedDescription.contains("may have completed")) }
        XCTAssertEqual(socket.sent.count, 1)
        XCTAssertTrue(socket.closed)
    }
    func testCancellationClosesSocketWithoutReplay() async {
        let socket = Socket([snapshot])
        let task = Task { try await SessionActions(makeSocket: { _ in socket }).perform(.end(id: "one"), at: address) }
        while socket.sent.isEmpty { await Task.yield() }
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected uncertain outcome") }
        catch { XCTAssertTrue(error.localizedDescription.contains("may have completed")) }
        XCTAssertTrue(socket.closed)
        XCTAssertEqual(socket.sent.count, 1)
    }
    func testMissingSessionDoesNotSendEndOrRename() async throws {
        let socket = Socket([snapshot])
        _ = try await SessionActions(makeSocket: { _ in socket }).perform(.end(id: "gone"), at: address)
        XCTAssertTrue(socket.sent.isEmpty)
        let rename = Socket([snapshot])
        do {
            _ = try await SessionActions(makeSocket: { _ in rename }).perform(.rename(id: "gone", name: "New"), at: address)
            XCTFail("Expected missing session")
        } catch { XCTAssertTrue(error.localizedDescription.contains("no longer available")) }
        XCTAssertTrue(rename.sent.isEmpty)
    }
}
