import XCTest
@testable import AgentboardSpike

final class CatalogPolicyTests: XCTestCase {
    private func session(_ id: String, project: String = "/one", host: String? = nil, status: BoardSession.Status = .working) -> BoardSession {
        .init(id: id, name: id, project: project, agent: "Shell", status: status, summary: "", host: host)
    }
    private func conversation(_ id: String, project: String, host: String?) throws -> AgentLogSession {
        var object: [String: Any] = ["sessionId": id, "displayName": id, "projectPath": project, "agentType": "codex", "lastActivityAt": "2026-01-01T00:00:00Z"]
        if let host { object["host"] = host }
        return try JSONDecoder().decode(AgentLogSession.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testProjectAndHostSelectionsIntersectForLiveAndDormantSessions() throws {
        let selection = CatalogSelection(projects: ["/one"], hosts: ["remote"])
        XCTAssertTrue(selection.includes(project: "/one", host: "remote"))
        XCTAssertFalse(selection.includes(project: "/one", host: nil))
        XCTAssertFalse(selection.includes(project: "/two", host: "remote"))
        let logs = try [conversation("match", project: "/one", host: "remote"), conversation("wrong-host", project: "/one", host: nil), conversation("wrong-project", project: "/two", host: "remote")]
        XCTAssertEqual(selection.conversations(logs).map(\.id), ["match"])
        XCTAssertEqual(CatalogSelection().conversations(logs).count, 3)
        XCTAssertEqual(CatalogSelection(hosts: [""]).conversations(logs).map(\.id), ["wrong-host"])
    }
    func testSelectedChoicesStayAvailableWhileSearchingOrDisconnected() {
        XCTAssertEqual(CatalogSelection.choices(["/one", "/two", "/one"], selected: ["/missing"], query: "two"), ["/missing", "/two"])
        XCTAssertEqual(CatalogSelection.choices([""], selected: [], query: "local"), [""])
        XCTAssertEqual(CatalogSelection.choices(["/one", "/two"], selected: [], query: "absent"), [])
    }
    func testAttentionIncludesApprovalsHiddenByEitherFilterWithoutDoubleCounting() {
        let sessions = [session("visible", host: "chosen", status: .permission), session("project", project: "/two", host: "chosen", status: .permission), session("host", host: "other", status: .permission), session("both", project: "/two", host: "other", status: .permission), session("working", project: "/two", host: "other")]
        XCTAssertEqual(CatalogSelection(projects: ["/one"], hosts: ["chosen"]).hiddenPermissions(in: sessions), 3)
        XCTAssertEqual(CatalogSelection().hiddenPermissions(in: sessions), 0)
        XCTAssertEqual(CatalogSelection(projects: ["/one", "/one"], hosts: ["chosen"]).activeCount, 2)
    }
    func testWireManagedSourceSurvivesConversionForCapabilityChecks() throws {
        let json = #"{"id":"remote","name":"Remote","projectPath":"/one","status":"waiting","remote":true,"source":"managed"}"#
        let session = try JSONDecoder().decode(RemoteSession.self, from: Data(json.utf8)).boardSession
        XCTAssertTrue(session.remote)
        XCTAssertEqual(session.source, "managed")
        XCTAssertTrue(SessionCapabilities.canControl(session, remoteAllowed: true))
        XCTAssertFalse(SessionCapabilities.canControl(session, remoteAllowed: false))
    }
    func testRemoteControlNeedsBothServerCapabilityAndManagedSource() {
        var item = session("remote")
        XCTAssertTrue(SessionCapabilities.canControl(item, remoteAllowed: false))
        item.remote = true
        XCTAssertFalse(SessionCapabilities.canControl(item, remoteAllowed: true))
        item.source = "discovered"
        XCTAssertFalse(SessionCapabilities.canControl(item, remoteAllowed: true))
        item.source = "managed"
        XCTAssertFalse(SessionCapabilities.canControl(item, remoteAllowed: false))
        XCTAssertTrue(SessionCapabilities.canControl(item, remoteAllowed: true))
        item.boardID = "saved"
        XCTAssertFalse(SessionCapabilities.canHibernate(item))
        item.remote = false
        XCTAssertTrue(SessionCapabilities.canHibernate(item))
        item.boardID = nil
        XCTAssertFalse(SessionCapabilities.canHibernate(item))
        item.agentSessionID = "agent-log"
        XCTAssertTrue(SessionCapabilities.canHibernate(item))
    }
}
