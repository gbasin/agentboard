import Foundation
import Combine

/// A single retained page and a bounded cursor history; stale responses never cross identities or searches.
@MainActor final class MediaCatalogModel: ObservableObject {
    enum State: Equatable { case idle, loading, failed(String) }
    typealias Reader = (MediaCatalogSource, [String: String], @escaping @MainActor (MediaCatalogTransport.Event) throws -> Void) async throws -> Void
    @Published private(set) var page: MediaCatalogPage?
    @Published private(set) var state: State = .idle
    @Published private(set) var summary: MediaCatalogSummary?
    @Published private(set) var changed = false
    @Published private(set) var pageNumber = 0
    private(set) var source: MediaCatalogSource?
    private var task: Task<Void, Never>?
    private var generation = 0
    private var cursors: [Int: String] = [:]
    private var kind = "", search = "", requestedRevision: String?
    private let reader: Reader
    init(reader: @escaping Reader = { source, query, receive in
        try await MediaCatalogTransport.read(source: source, query: query, receive: receive)
    }) { self.reader = reader }
    var loading: Bool { state == .loading }
    var canPrevious: Bool { !loading && !changed && pageNumber > 0 && (pageNumber == 1 || cursors[pageNumber - 1] != nil) }
    var canNext: Bool { !loading && !changed && page?.nextCursor != nil && summary?.discovery?.running != true }

    func configure(source: MediaCatalogSource, summary: MediaCatalogSummary, kind: String, search: String) {
        // The server uses JavaScript string length (UTF-16), not Swift grapheme count.
        var query = ""
        for character in search {
            let candidate = query + String(character)
            guard candidate.utf16.count <= 200 else { break }
            query = candidate
        }
        guard self.source != source || self.kind != kind || self.search != query else { observe(summary); resume(); return }
        cancel(); self.source = source; self.summary = summary; self.kind = kind; self.search = query
        page = nil; pageNumber = 0; cursors = [:]; changed = false; requestedRevision = nil
        load(number: 0, cursor: nil)
    }
    func observe(_ value: MediaCatalogSummary) {
        guard value.identity == source?.identity else { return }
        summary = value
        if !loading, let page, value.revision != page.revision && value.revision != requestedRevision { changed = true }
    }
    func refresh() { cancel(); cursors = [:]; changed = false; load(number: 0, cursor: nil) }
    func next() { guard canNext else { return }; load(number: pageNumber + 1, cursor: page?.nextCursor) }
    func previous() { guard canPrevious else { return }; load(number: pageNumber - 1, cursor: cursors[pageNumber - 1]) }
    func cancel() { generation += 1; task?.cancel(); task = nil; if loading { state = .idle } }
    func resume() { if !loading && (page == nil || summary?.discovery?.running == true) { refresh() } }

    private func load(number: Int, cursor: String?) {
        guard let source, let summary, !loading else { return }
        generation += 1; let token = generation
        state = .loading
        let initialRevision = summary.revision
        let pageRevision = number == 0 ? nil : page?.revision
        var query: [String: String] = [:]
        if let cursor { query["cursor"] = cursor }
        if !kind.isEmpty { query["kind"] = kind }
        if !search.isEmpty { query["search"] = search }
        if summary.discovery != nil { query["stream"] = "1" }
        task = Task { [weak self, reader] in
            do {
                for continuation in 0...3 {
                    var discovery: MediaDiscovery?
                    try await reader(source, query) { [weak self] event in
                        guard let self, self.generation == token, self.source == source, !Task.isCancelled else { return }
                        switch event.type {
                        case "snapshot":
                            guard let value = event.page else { throw MediaCatalogError.unavailable }
                            try value.validate(identity: source.identity)
                            if let pageRevision, value.revision != pageRevision { throw MediaCatalogError.changed }
                            discovery = value.discovery
                            self.summary?.discovery = value.discovery
                            // Like the PWA, keep a nonempty visible page fixed across finite renewals.
                            if continuation > 0 && self.page?.items.isEmpty == false { return }
                            self.page = value; self.pageNumber = number; self.requestedRevision = initialRevision
                            self.changed = false
                            if let cursor { self.cursors[number] = cursor }
                            if let next = value.nextCursor { self.cursors[number + 1] = next }
                            while self.cursors.count > 128 || self.cursors.values.reduce(0, { $0 + $1.utf8.count }) > 64 * 1024 {
                                if let oldest = self.cursors.keys.min() { self.cursors.removeValue(forKey: oldest) }
                            }
                        case "progress":
                            if let value = event.summary, value.identity == source.identity {
                                discovery = value.discovery; self.summary = value
                            }
                        case "error":
                            if event.code == "STALE_CURSOR" { throw MediaCatalogError.changed }
                            throw SessionActionError(message: event.message ?? "Could not load media.")
                        default: break
                        }
                    }
                    guard let self, self.generation == token, !Task.isCancelled else { return }
                    // Catalog broadcasts can lag the open stream. Its last event decides renewal.
                    self.summary?.discovery = discovery
                    if discovery?.status == "failed" {
                        throw SessionActionError(message: discovery?.message ?? "Media discovery failed.")
                    }
                    guard discovery?.running == true else { break }
                    guard continuation < 3 else {
                        throw SessionActionError(message: "Discovery is still incomplete. Retry to continue.")
                    }
                    try await Task.sleep(for: .milliseconds(250 * (continuation + 1)))
                }
                guard let self, self.generation == token else { return }
                self.state = self.page == nil ? .failed("No media response. Try again.") : .idle
                if let latest = self.summary { self.observe(latest) }
            } catch {
                guard let self, self.generation == token, !Task.isCancelled else { return }
                if case MediaCatalogError.changed = error { self.changed = true }
                self.state = .failed(error.localizedDescription)
            }
        }
    }
}
