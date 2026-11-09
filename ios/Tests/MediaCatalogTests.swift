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
    func testFiniteDiscoveryRenewsAndRetainsVisiblePage() async throws {
        var reads = 0
        var pending = summary(); pending.discovery = .init(status: "pending")
        let model = MediaCatalogModel { _, _, receive in
            reads += 1
            var snapshot = self.page(reads == 1 ? "r1" : "r2", label: reads == 1 ? "original" : "newer")
            snapshot.discovery = .init(status: reads == 1 ? "indexing" : "ready")
            try receive(.init(type: "snapshot", page: snapshot))
            var progress = self.summary(reads == 1 ? "r1" : "r2"); progress.discovery = snapshot.discovery
            try receive(.init(type: "progress", summary: progress))
        }
        model.configure(source: source, summary: pending, kind: "", search: "")
        for _ in 0..<100 where model.loading { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(reads, 2); XCTAssertFalse(model.loading)
        XCTAssertEqual(model.page?.items.first?.label, "original")
        XCTAssertEqual(model.summary?.discovery?.status, "ready")
        XCTAssertTrue(model.changed); XCTAssertFalse(model.canNext)
        model.refresh(); await settle(model)
        XCTAssertEqual(reads, 3)
        XCTAssertEqual(model.page?.items.first?.label, "newer")
        XCTAssertFalse(model.changed)
    }
    func testDiscoveryRenewalIsBoundedAndExplicitRetryResetsBudget() async throws {
        var reads = 0, ready = false
        var pending = summary(); pending.discovery = .init(status: "pending")
        let model = MediaCatalogModel { _, _, receive in
            reads += 1
            var snapshot = self.page(); snapshot.discovery = .init(status: ready ? "ready" : "indexing")
            try receive(.init(type: "snapshot", page: snapshot))
        }
        model.configure(source: source, summary: pending, kind: "", search: "")
        for _ in 0..<150 where model.loading { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(reads, 4)
        XCTAssertEqual(model.state, .failed("Discovery is still incomplete. Retry to continue."))
        ready = true; model.refresh(); await settle(model)
        XCTAssertEqual(reads, 5); XCTAssertEqual(model.state, .idle)
    }
    func testCancellationStopsRenewalAndForegroundResumesPartialDiscovery() async throws {
        var reads = 0, ready = false
        var pending = summary(); pending.discovery = .init(status: "pending")
        let model = MediaCatalogModel { _, _, receive in
            reads += 1
            var snapshot = self.page(); snapshot.discovery = .init(status: ready ? "ready" : "indexing")
            try receive(.init(type: "snapshot", page: snapshot))
        }
        model.configure(source: source, summary: pending, kind: "", search: "")
        for _ in 0..<100 where model.page == nil { await Task.yield() }
        XCTAssertNotNil(model.page); model.cancel()
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertEqual(reads, 1); XCTAssertEqual(model.state, .idle)
        ready = true; model.resume(); await settle(model)
        XCTAssertEqual(reads, 2); XCTAssertEqual(model.summary?.discovery?.status, "ready")
    }

    func testLaggingCatalogCannotFinishAnIncompleteStream() async throws {
        var reads = 0
        var pending = summary(); pending.discovery = .init(status: "pending")
        weak var observedModel: MediaCatalogModel?
        let model = MediaCatalogModel { _, _, receive in
            reads += 1
            var snapshot = self.page(); snapshot.discovery = .init(status: reads == 1 ? "indexing" : "ready")
            try receive(.init(type: "snapshot", page: snapshot))
            var stale = self.summary(); stale.discovery = .init(status: reads == 1 ? "ready" : "indexing")
            observedModel?.observe(stale)
        }
        observedModel = model
        model.configure(source: source, summary: pending, kind: "", search: "")
        for _ in 0..<100 where model.loading { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(reads, 2); XCTAssertEqual(model.state, .idle)
        XCTAssertEqual(model.summary?.discovery?.status, "ready")
    }

}
