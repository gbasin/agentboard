import XCTest
@testable import AgentboardSpike

final class NativeCatalogMetadataTests: XCTestCase {
    func testProjectColorsMatchWebIncludingUTF16Names() {
        for (name, hue) in [("agentboard", 255.0), ("eichler", 175.0), ("alpha", 50.0), ("beta", 225.0), ("工程🚀", 85.0)] {
            XCTAssertEqual(ProjectChip.hue(for: name), hue, name)
        }
    }

    private func decode(_ extra: String = "") throws -> BoardSession {
        let json = """
        {"id":"one","name":"One","projectPath":"/project","status":"working"\(extra)}
        """
        return try JSONDecoder().decode(RemoteSession.self, from: Data(json.utf8)).boardSession
    }

    func testOlderServerDoesNotPretendToReportZeroSubagents() throws {
        let session = try decode()
        XCTAssertNil(session.activity)
        XCTAssertNil(session.shortAgentID)
    }

    func testActivitySchemaPreservesUnknownAndTruncatedObservations() throws {
        let session = try decode(#", "activity":{"main":{"phase":"model","label":"Thinking","tools":[]},"subagents":[{"id":"child","name":"Review","activity":{"phase":"unknown","label":"No recent signal","updatedAt":"2026-11-07T15:00:00Z","tools":["Read"]}}],"running":0,"unknown":3,"blocked":1,"total":4,"truncated":true}"#)
        let activity = try XCTUnwrap(session.activity)
        XCTAssertEqual(activity.total, 4)
        XCTAssertEqual(activity.subagents.count, 1)
        XCTAssertTrue(activity.truncated)
        XCTAssertEqual(activity.subagents.first?.activity.tools, ["Read"])
        XCTAssertEqual(activity.summary, "0 running · 1 awaiting input · 3 unknown · 4 total")
    }

    func testShortIdentifierMatchesPWAPrefixSuffixAndTrimming() throws {
        XCTAssertEqual(try decode(#", "agentSessionId":" 0123456789abcdef ""#).shortAgentID, "012…def")
        XCTAssertEqual(try decode(#", "agentSessionId":" abc123 ""#).shortAgentID, "abc123")
        XCTAssertNil(try decode(#", "agentSessionId":"  ""#).shortAgentID)
    }

    func testRecencyBoundariesAndInvalidDates() throws {
        let now = try XCTUnwrap(BoardSession.activityDate("2026-11-07T15:00:00Z"))
        XCTAssertEqual(BoardSession.relativeActivity("2026-11-07T14:59:59.250Z", now: now), "now")
        XCTAssertEqual(BoardSession.relativeActivity("2026-11-07T14:59:00Z", now: now), "1m")
        XCTAssertEqual(BoardSession.relativeActivity("2026-11-07T14:00:00Z", now: now), "1h")
        XCTAssertEqual(BoardSession.relativeActivity("2026-11-06T15:00:00Z", now: now), "1d")
        XCTAssertEqual(BoardSession.relativeActivity("2026-11-08T15:00:00Z", now: now), "now")
        XCTAssertEqual(BoardSession.relativeActivity("not a date", now: now), "")
    }
}
