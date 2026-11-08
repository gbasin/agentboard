import Foundation
import Combine

struct MediaImageNeighbors: Decodable {
    let identity: String
    let revision: String
    let current: MediaItem
    let previous: MediaItem?
    let next: MediaItem?
}

/// Image traversal uses content-addressed neighbors, independent of retained list pages.
@MainActor final class MediaImageNavigation: ObservableObject {
    @Published private(set) var neighbors: MediaImageNeighbors?
    @Published private(set) var error: String?
    @Published private(set) var loading = false
    private var generation = 0
    func clear() { generation += 1; neighbors = nil; error = nil; loading = false }
    func load(source: MediaCatalogSource, item: MediaItem) async {
        clear(); let token = generation; loading = true
        defer { if generation == token { loading = false } }
        do {
            let api = try BoardAPI(source.server)
            var request = URLRequest(url: api.url("api/session-media/\(source.sessionID)/neighbors", query: ["anchor": item.url]))
            request.timeoutInterval = 20; request.cachePolicy = .reloadIgnoringLocalCacheData
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                if (response as? HTTPURLResponse)?.statusCode == 409 { throw MediaCatalogError.changed }
                throw MediaCatalogError.unavailable
            }
            var data = Data()
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < 64 * 1024 else { throw MediaCatalogError.oversized }
                data.append(byte)
            }
            let result = try JSONDecoder().decode(MediaImageNeighbors.self, from: data)
            guard result.identity == source.identity, result.current.url == item.url,
                  [result.current, result.previous, result.next].compactMap({ $0 }).allSatisfy({ $0.kind == "image" }) else {
                throw MediaCatalogError.changed
            }
            guard generation == token, !Task.isCancelled else { return }
            neighbors = result
        } catch {
            guard generation == token, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}
