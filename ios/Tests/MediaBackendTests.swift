import XCTest
import QuickLook
@testable import AgentboardSpike

/// Requires media-activity-fixture.ts and the isolated current backend on port 4151.
@MainActor final class MediaBackendTests: XCTestCase {
    private let provider = "22222222-3333-4444-8555-666666666666"
    private func source() async throws -> MediaCatalogSource {
        let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:4151/api/sessions")!)
        let sessions = try JSONDecoder().decode([RemoteSession].self, from: data).map(\.boardSession)
        let session = try XCTUnwrap(sessions.first { $0.agentSessionID == provider })
        return .init(server: "http://127.0.0.1:4151", sessionID: provider, identity: try XCTUnwrap(session.mediaSummary?.identity))
    }
    private func page(_ source: MediaCatalogSource, query: [String: String]) async throws -> MediaCatalogPage {
        var result: MediaCatalogPage?
        try await MediaCatalogTransport.read(source: source, query: query) { event in
            if event.type == "snapshot" { result = event.page }
            if event.type == "error" { XCTFail(event.message ?? "Stream error") }
        }
        let value = try XCTUnwrap(result); try value.validate(identity: source.identity); return value
    }
    func testRealTransportTraversesCatalogWithoutDuplicatesAndFiltersSearch() async throws {
        let source = try await source()
        var query = ["stream": "1"], urls = Set<String>(), pages = 0
        repeat {
            let result = try await page(source, query: query)
            XCTAssertLessThanOrEqual(result.items.count, 40)
            for item in result.items { XCTAssertTrue(urls.insert(item.url).inserted) }
            pages += 1
            guard let cursor = result.nextCursor else { break }
            query["cursor"] = cursor
        } while pages < 10
        XCTAssertEqual(urls.count, 180); XCTAssertEqual(pages, 5)
        let search = try await page(source, query: ["kind": "links", "search": "native-042", "stream": "1"])
        XCTAssertEqual(search.total, 1)
        XCTAssertEqual(search.items.first?.label, "Catalog reference 042")
    }
    func testAttachmentDownloadsExactBytesIntoPrivatePreviewFile() async throws {
        let id = "11111111-2222-4333-8444-555555555555"
        let api = try BoardAPI("http://127.0.0.1:4151")
        let page: MediaCatalogPage = try await api.request("api/session-media/\(id)/items")
        let item = try XCTUnwrap(page.items.first { $0.kind == "document" && $0.mediaType == "text/html" })
        let url = try XCTUnwrap(resolved(item.url, server: "http://127.0.0.1:4151"))
        let file = try await DocumentDownload.load(url: url, mediaType: item.mediaType)
        defer { DocumentDownload.remove(file) }
        XCTAssertEqual(file.pathExtension, "html")
        XCTAssertTrue(try String(contentsOf: file, encoding: .utf8).contains("<h1>Native document fixture</h1>"))
        XCTAssertTrue(file.deletingLastPathComponent().lastPathComponent.hasPrefix("AgentboardDocument-"))
    }
    func testPDFDownloadsForQuickLookAndRemovesItsPrivateCopy() async throws {
        let api = try BoardAPI("http://127.0.0.1:4151")
        let page: MediaCatalogPage = try await api.request("api/session-media/11111111-2222-4333-8444-555555555555/items")
        let item = try XCTUnwrap(page.items.first { $0.mediaType == "application/pdf" })
        let url = try XCTUnwrap(resolved(item.url, server: "http://127.0.0.1:4151"))
        let file = try await DocumentDownload.load(url: url, mediaType: item.mediaType)
        defer { DocumentDownload.remove(file) }
        XCTAssertEqual(file.pathExtension, "pdf")
        XCTAssertTrue(try Data(contentsOf: file).starts(with: Data("%PDF-1.4".utf8)))
        XCTAssertTrue(QLPreviewController.canPreview(file as NSURL))
        DocumentDownload.remove(file)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.deletingLastPathComponent().path))
    }
    func testImageNeighborsCrossRetainedPageBoundaryAndThumbnailLoads() async throws {
        let source = try await source()
        let first = try await page(source, query: [:])
        var item = try XCTUnwrap(first.items.first { $0.kind == "image" })
        let firstPage = Set(first.items.map(\.url))
        let navigator = MediaImageNavigation()
        var visited = Set<String>()
        for _ in 0..<21 {
            XCTAssertTrue(visited.insert(item.url).inserted)
            await navigator.load(source: source, item: item)
            XCTAssertNil(navigator.error)
            item = try XCTUnwrap(navigator.neighbors?.next)
        }
        XCTAssertFalse(firstPage.contains(item.url))
        let original = try XCTUnwrap(resolved(item.url, server: source.server))
        let (thumbnail, response) = try await URLSession.shared.data(from: URL(string: original.absoluteString + "&thumbnail=1")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertFalse(thumbnail.isEmpty)
        XCTAssertLessThanOrEqual(thumbnail.count, 512 * 1024)
    }
}
