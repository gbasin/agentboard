import XCTest
import UIKit
@testable import AgentboardSpike

@MainActor
final class NativeParityTests: XCTestCase {
    let api = try! BoardAPI("http://127.0.0.1:4151")
    func testSharedParserAndPermissionRules() throws {
        let lines = [#"{"type":"user","message":{"role":"user","content":"Hello"}}"#,
                     #"{"type":"assistant","message":{"role":"assistant","content":"World"}}"#]
        XCTAssertEqual(TranscriptParser.entries(lines).map(\.text), ["World", "Hello"])
        XCTAssertTrue(CommandPermission.state("codex").available)
        let command = CommandPermission.set("codex", enabled: true)
        XCTAssertTrue(CommandPermission.state(command).enabled)
        XCTAssertFalse(CommandPermission.state(CommandPermission.set(command, enabled: false)).enabled)
        XCTAssertFalse(CommandPermission.state("/bin/zsh").available)
    }
    func testServerAPISettingsDirectoriesLibraryTranscriptAndUpload() async throws {
        let directory: DirectoryPage = try await api.request("api/directories", query: ["path": "/tmp/ab-ios-parity/project"])
        XCTAssertTrue(directory.directories.contains { $0.name == "child" })
        do { let _: DirectoryPage = try await api.request("api/directories", query: ["path": "/ab-does-not-exist"]); XCTFail("Expected error") }
        catch { XCTAssertTrue(error.localizedDescription.contains("does not exist")) }
        let initial: NativePreferences.Response = try await api.request("api/settings/synced")
        let updated: NativePreferences.Response = try await api.request("api/settings/synced", method: "PUT", body: ["settings": ["showSessionIdPrefix": true]])
        XCTAssertEqual(updated.settings["showSessionIdPrefix"], .bool(true))
        let _: NativePreferences.Response = try await api.request("api/settings/synced", method: "PUT", body: ["settings": ["showSessionIdPrefix": initial.settings["showSessionIdPrefix"]?.bool ?? false]])
        let page: HistoryPage = try await api.request("api/library", query: ["q": "parity-saved-transcript", "state": "all", "limit": "1"])
        XCTAssertEqual(page.sessions.first?.name, "parity-saved-transcript")
        let detail: HistoryDetail = try await api.request("api/library/parity-saved-transcript")
        XCTAssertEqual(detail.conversations.first?.displayName, "parity-saved-transcript")
        let pinned: SavedSession = try await api.request("api/library/parity-saved-transcript", method: "PATCH", body: ["pinned": true])
        XCTAssertTrue(pinned.pinned)
        let _: SavedSession = try await api.request("api/library/parity-saved-transcript", method: "PATCH", body: ["pinned": false])
        let transcript: TranscriptPage = try await api.request("api/session-preview/11111111-2222-4333-8444-555555555555", query: ["limit": "20"])
        XCTAssertTrue(transcript.hasMoreBefore)
        XCTAssertFalse(TranscriptParser.entries(transcript.lines).isEmpty)
        let earlier: TranscriptPage = try await api.request("api/session-preview/11111111-2222-4333-8444-555555555555", query: ["limit": "20", transcript.startByte == nil ? "beforeLine" : "beforeByte": String(transcript.startByte ?? transcript.startLine)])
        XCTAssertNotEqual(earlier.lines, transcript.lines)
        let path = try await api.upload(Data("Native upload bytes".utf8), name: "test file.txt")
        XCTAssertTrue(path.hasPrefix("/")); XCTAssertTrue(path.hasSuffix("test file.txt"))
        XCTAssertEqual(BoardAPI.shellQuote("it's a file"), "'it'\\''s a file'")
    }
    func testLibraryHibernateResumeAndArchiveActualShell() async throws {
        let name = "parity-api-" + String(UUID().uuidString.prefix(6))
        let session = try await SessionActions().perform(.create(project: "/tmp/ab-ios-parity/project", name: name, command: "/bin/zsh -f", host: ""), at: api.address)
        let id = try XCTUnwrap(session?.boardID)
        let asleep: SavedSession = try await api.request("api/library/\(id)", method: "PATCH", body: ["state": "hibernating"])
        XCTAssertEqual(asleep.state, "hibernating")
        let resumed: RemoteSession = try await api.request("api/library/\(id)/resume", method: "POST", body: ["operationId": UUID().uuidString])
        XCTAssertEqual(resumed.boardSessionId, id)
        let archived: SavedSession = try await api.request("api/library/\(id)", method: "PATCH", body: ["state": "archived"])
        XCTAssertEqual(archived.state, "archived")
    }
    func testAdditionalWireEventsAndMediaURLPrefix() throws {
        let json = #"{"type":"session-wake-result","sessionId":"a","ok":false,"error":{"code":"NOT_FOUND","message":"Missing"}}"#
        let event = try JSONDecoder().decode(BoardEvent.self, from: Data(json.utf8))
        XCTAssertEqual(event.sessionId, "a"); XCTAssertEqual(event.ok, false)
        XCTAssertEqual(resolved("/api/file?q=1", server: "https://host/prefix")?.absoluteString, "https://host/prefix/api/file?q=1")
        XCTAssertNil(resolved("javascript:alert(1)", server: "https://host"))
    }
    func testConversationRenameWakeHibernateAndHistory() async throws {
        let id = "11111111-2222-4333-8444-555555555555"
        _ = try await SessionActions().perform(.renameConversation(id: id, name: "parity-renamed"), at: api.address)
        _ = try await SessionActions().perform(.renameConversation(id: id, name: "parity-saved-transcript"), at: api.address)
        let awake = try await SessionActions().perform(.lifecycle(type: "session-wake", id: id), at: api.address)
        XCTAssertNotNil(awake)
        _ = try await SessionActions().perform(.lifecycle(type: "session-hibernate", id: id), at: api.address)
        _ = try await SessionActions().perform(.lifecycle(type: "session-move-to-history", id: id), at: api.address)
        let _: SavedSession = try await api.request("api/library/parity-saved-transcript", method: "PATCH", body: ["name": "parity-saved-transcript"])
    }
    func testMediaBytesAndServerSettingsRoundTrip() async throws {
        let detail: HistoryDetail = try await api.request("api/library/parity-saved-transcript")
        let conversation = try XCTUnwrap(detail.conversations.first)
        var media = conversation.media ?? []
        if let summary = conversation.mediaSummary {
            let source = MediaCatalogSource(server: api.address.baseURL.absoluteString, sessionID: conversation.sessionId, identity: summary.identity)
            try await MediaCatalogTransport.read(source: source, query: [:]) { event in
                if let page = event.page { try page.validate(identity: source.identity); media = page.items }
            }
        }
        XCTAssertEqual(media.count, 4)
        XCTAssertTrue(media.contains { $0.mediaType == "application/pdf" })
        let image = try XCTUnwrap(media.first { $0.kind == "image" })
        let (data, response) = try await URLSession.shared.data(from: XCTUnwrap(resolved(image.url, server: api.address.baseURL.absoluteString)))
        try BoardAPI.check(data, response)
        XCTAssertEqual(UIImage(data: data)?.size.width, 32)
        XCTAssertTrue(media.contains { $0.kind == "document" }); XCTAssertTrue(media.contains { $0.kind == "link" })
        for endpoint in ["tmux-mouse-mode", "terminal-colors", "prefer-window-name"] {
            let before: [String: JSONValue] = try await api.request("api/settings/\(endpoint)")
            let enabled = try XCTUnwrap(before["enabled"]?.bool)
            let changed: [String: JSONValue] = try await api.request("api/settings/\(endpoint)", method: "PUT", body: ["enabled": !enabled])
            XCTAssertEqual(changed["enabled"], .bool(!enabled))
            let _: EmptyResponse = try await api.request("api/settings/\(endpoint)", method: "PUT", body: ["enabled": enabled])
        }
        let health: LibraryHealth = try await api.request("api/library/health")
        let _: EmptyResponse = try await api.request("api/library/settings", method: "PUT", body: ["capturePreviews": !health.settings.capturePreviews])
        let changed: LibraryHealth = try await api.request("api/library/health")
        XCTAssertEqual(changed.settings.capturePreviews, !health.settings.capturePreviews)
        let _: EmptyResponse = try await api.request("api/library/settings", method: "PUT", body: ["capturePreviews": health.settings.capturePreviews])
    }
    func testQueuedNativePreferencesPersistAndPreserveOtherSettings() async throws {
        let initial: NativePreferences.Response = try await api.request("api/settings/synced")
        let preferences = NativePreferences(); preferences.serverURL = api.address.baseURL.absoluteString; preferences.shared = initial.settings
        preferences.set("showSessionIdPrefix", .bool(true)); preferences.set("showSessionIdPrefix", .bool(false))
        preferences.set("showProjectName", .bool(true))
        for _ in 0..<100 where preferences.saving { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertFalse(preferences.saving); XCTAssertNil(preferences.error)
        XCTAssertEqual(preferences.shared["showSessionIdPrefix"], .bool(false))
        XCTAssertEqual(preferences.shared["commandPresets"], initial.settings["commandPresets"])
        let _: EmptyResponse = try await api.request("api/settings/synced", method: "PUT", body: ["settings": ["showSessionIdPrefix": initial.settings["showSessionIdPrefix"]?.bool ?? false, "showProjectName": initial.settings["showProjectName"]?.bool ?? true]])
    }

}
