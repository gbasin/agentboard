import Foundation

/// Current catalog contract; absent discovery means an older, completed index.
struct MediaDiscovery: Decodable, Hashable {
    let status: String
    var bytesRead: Int? = nil
    var bytesTotal: Int? = nil
    var message: String? = nil
    var running: Bool { status == "pending" || status == "indexing" }
}
struct MediaCatalogSummary: Decodable, Hashable {
    let identity: String
    let revision: String
    let total: Int
    let images: Int
    let documents: Int
    let links: Int
    let additions: Int
    var previews: Int? = nil
    var omittedRecords: Int? = nil
    var omittedItems: Int? = nil
    var discovery: MediaDiscovery? = nil
}
struct MediaCatalogPage: Decodable {
    let identity: String
    let revision: String
    let total: Int
    let items: [MediaItem]
    let nextCursor: String?
    var omittedItems: Int? = nil
    var discovery: MediaDiscovery? = nil

    func validate(identity expected: String) throws {
        guard identity == expected, total >= 0, items.count <= 40,
              (nextCursor?.utf8.count ?? 0) <= 8192,
              items.allSatisfy({ ["image", "document", "link", "html", "localhost", "visualization"].contains($0.kind) }) else {
            throw MediaCatalogError.changed
        }
    }
}
enum MediaCatalogError: LocalizedError {
    case changed, oversized, unavailable
    var errorDescription: String? {
        switch self {
        case .changed: "Media changed. Refresh to continue."
        case .oversized: "The media response exceeded its size limit."
        case .unavailable: "Could not load media. Try again."
        }
    }
}
struct MediaCatalogSource: Equatable {
    let server: String
    let sessionID: String
    let identity: String
}

/// One bounded response or finite NDJSON stream. Cancellation closes the byte iterator.
enum MediaCatalogTransport {
    struct Event: Decodable {
        let type: String
        var page: MediaCatalogPage? = nil
        var summary: MediaCatalogSummary? = nil
        var message: String? = nil
        var code: String? = nil
    }
    static func read(source: MediaCatalogSource, query: [String: String],
                     receive: @MainActor (Event) throws -> Void) async throws {
        let api = try BoardAPI(source.server)
        var request = URLRequest(url: api.url("api/session-media/\(source.sessionID)/items", query: query))
        request.timeoutInterval = 65
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            if (response as? HTTPURLResponse)?.statusCode == 409 { throw MediaCatalogError.changed }
            throw MediaCatalogError.unavailable
        }
        let stream = http.value(forHTTPHeaderField: "Content-Type")?.contains("ndjson") == true
        var buffer = Data(), count = 0
        for try await byte in bytes {
            try Task.checkCancellation()
            count += 1
            guard count <= (stream ? 512 * 1024 : 64 * 1024) else { throw MediaCatalogError.oversized }
            if stream && byte == 10 {
                if !buffer.isEmpty {
                    let event = try JSONDecoder().decode(Event.self, from: buffer)
                    try await receive(event)
                    if event.type == "done" { return }
                    buffer.removeAll(keepingCapacity: true)
                }
            } else {
                guard buffer.count < 64 * 1024 else { throw MediaCatalogError.oversized }
                buffer.append(byte)
            }
        }
        if stream {
            // A finite stream must close with its done event; EOF alone may be a disconnect.
            throw MediaCatalogError.unavailable
        } else {
            let page = try JSONDecoder().decode(MediaCatalogPage.self, from: buffer)
            try await receive(Event(type: "snapshot", page: page))
        }
    }
}
