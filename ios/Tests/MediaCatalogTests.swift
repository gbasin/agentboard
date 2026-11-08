import XCTest
@testable import AgentboardSpike

@MainActor final class MediaCatalogTests: XCTestCase {
    private let source = MediaCatalogSource(server: "http://localhost:4151", sessionID: "one", identity: "one-log")
    private func summary(_ revision: String = "r1") -> MediaCatalogSummary {
        .init(identity: "one-log", revision: revision, total: 90, images: 0, documents: 0, links: 90, additions: 0)
    }
    private func page(_ revision: String = "r1", cursor: String? = "next", label: String = "one") -> MediaCatalogPage {
        .init(identity: "one-log", revision: revision, total: 90,
              items: [.init(kind: "link", url: "https://example.com/\(label)", mediaType: nil, bytes: nil, label: label)], nextCursor: cursor)
    }
    private func settle(_ model: MediaCatalogModel) async {
        for _ in 0..<100 where model.loading { await Task.yield() }
        XCTAssertFalse(model.loading)
    }
    func testPagingRetainsOnePageAndUsesCursorForBackNavigation() async {
        var queries: [[String: String]] = []
        let model = MediaCatalogModel { _, query, receive in
            queries.append(query)
            try receive(.init(type: "snapshot", page: self.page(cursor: "next", label: query["cursor"] ?? "first")))
        }
        model.configure(source: source, summary: summary(), kind: "links", search: "needle")
        await settle(model)
        model.next(); await settle(model)
        XCTAssertEqual(model.pageNumber, 1)
        XCTAssertEqual(model.page?.items.count, 1)
        XCTAssertEqual(model.page?.items.first?.label, "next")
        XCTAssertEqual(queries.last?["cursor"], "next")
        XCTAssertEqual(queries.last?["search"], "needle")
        XCTAssertEqual(queries.last?["kind"], "links")
        model.previous(); await settle(model)
        XCTAssertEqual(model.pageNumber, 0)
        XCTAssertNil(queries.last?["cursor"])
    }
    func testRevisionChangeNeverMixesPagesAndRefreshRecovers() async {
        var revision = "r1"
        let model = MediaCatalogModel { _, _, receive in try receive(.init(type: "snapshot", page: self.page(revision))) }
        model.configure(source: source, summary: summary(), kind: "", search: "")
        await settle(model)
        revision = "r2"; model.next(); await settle(model)
        XCTAssertTrue(model.changed)
        XCTAssertFalse(model.canNext)
        XCTAssertEqual(model.page?.revision, "r1")
        XCTAssertEqual(model.pageNumber, 0)
        model.refresh(); await settle(model)
        XCTAssertFalse(model.changed)
        XCTAssertEqual(model.page?.revision, "r2")
        model.observe(summary()) // websocket can lag a newly returned page
        XCTAssertFalse(model.changed)
        model.observe(summary("r3"))
        XCTAssertTrue(model.changed)
    }
    func testCancelledReaderCannotPublishEvenIfItIgnoresCancellation() async {
        var callbacks: [@MainActor (MediaCatalogTransport.Event) throws -> Void] = []
        let model = MediaCatalogModel { _, _, receive in callbacks.append(receive) }
        model.configure(source: source, summary: summary(), kind: "", search: "old")
        await settle(model)
        model.configure(source: source, summary: summary(), kind: "", search: "new")
        await settle(model)
        XCTAssertEqual(callbacks.count, 2)
        try? callbacks[0](.init(type: "snapshot", page: page(label: "stale")))
        XCTAssertNil(model.page)
        try? callbacks[1](.init(type: "snapshot", page: page(label: "current")))
        XCTAssertEqual(model.page?.items.first?.label, "current")
        model.cancel()
        try? callbacks[1](.init(type: "snapshot", page: page(label: "late")))
        XCTAssertEqual(model.page?.items.first?.label, "current")
    }
    func testProgressiveSnapshotAndReadySignalEnablePaging() async {
        var pending = summary(); pending.discovery = .init(status: "pending")
        let model = MediaCatalogModel { _, query, receive in
            XCTAssertEqual(query["stream"], "1")
            var snapshot = self.page(); snapshot.discovery = .init(status: "indexing")
            try receive(.init(type: "snapshot", page: snapshot))
            var ready = self.summary(); ready.discovery = .init(status: "ready")
            try receive(.init(type: "progress", summary: ready))
        }
        model.configure(source: source, summary: pending, kind: "", search: "")
        await settle(model)
        XCTAssertEqual(model.summary?.discovery?.status, "ready")
        XCTAssertTrue(model.canNext)
    }
    func testUnicodeSearchHonorsServerUTF16LimitWithoutSplittingCharacters() async {
        let model = MediaCatalogModel { _, query, receive in
            XCTAssertEqual(query["search"], String(repeating: "😀", count: 100))
            try receive(.init(type: "snapshot", page: self.page()))
        }
        model.configure(source: source, summary: summary(), kind: "", search: String(repeating: "😀", count: 150))
        await settle(model)
    }
    func testIdentityAndPageBoundsRejectMalformedResponses() throws {
        XCTAssertThrowsError(try page().validate(identity: "other"))
        let oversized = MediaCatalogPage(identity: "one-log", revision: "r1", total: 100,
            items: Array(repeating: page().items[0], count: 41), nextCursor: nil)
        XCTAssertThrowsError(try oversized.validate(identity: "one-log"))
        let longCursor = page(cursor: String(repeating: "x", count: 8193))
        XCTAssertThrowsError(try longCursor.validate(identity: "one-log"))
    }
}
