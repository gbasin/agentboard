import SwiftUI

struct PullRequestStatus: Decodable, Equatable {
    let url: String
    let state: String?
    let isDraft: Bool?
    let title: String?
    let author: String?
    let headSha: String?
    let lastConfirmedAt: Double?
    let stale: Bool?
    let error: String?

    var label: String {
        if state == "OPEN", isDraft == true { return "Draft" }
        return state?.capitalized ?? "State unavailable"
    }

    var color: Color {
        switch state {
        case "MERGED": .purple
        case "CLOSED": .red
        case "OPEN": isDraft == true ? .secondary : .green
        default: .secondary
        }
    }

    var symbol: String {
        switch state {
        case "MERGED": "arrow.triangle.merge"
        case "CLOSED": "xmark.circle"
        case "OPEN": isDraft == true ? "pencil.circle" : "arrow.triangle.branch"
        default: "questionmark.circle"
        }
    }
}

/// Live PR updates are independent from the session list and terminal.
@MainActor
final class BoardPullRequests: ObservableObject {
    @Published private(set) var statuses: [String: PullRequestStatus] = [:]
    private var snapshot: Task<Void, Never>?
    private var requested = Set<String>()
    private var pending = Set<String>()

    private func key(for url: String) -> String {
        url.lowercased().replacingOccurrences(of: "(/pull/)0+(?=\\d+$)", with: "$1", options: .regularExpression)
    }

    subscript(url: String) -> PullRequestStatus? { statuses[key(for: url)] }

    func apply(_ values: [PullRequestStatus], baseline: [String: PullRequestStatus]? = nil) {
        var next = statuses
        for value in values where value.error == nil {
            let key = key(for: value.url)
            let previous = next[key]
            let currentTime = previous?.lastConfirmedAt ?? 0
            let receivedTime = value.lastConfirmedAt ?? 0
            guard receivedTime >= currentTime else { continue }
            if receivedTime == currentTime, let baseline, baseline[key] != previous { continue }
            next[key] = value
        }
        if next != statuses { statuses = next }
    }

    func refresh(_ items: [PullRequestItem], server: String, force: Bool = false) {
        if force { stop() }
        let urls = Set(items.map { key(for: $0.url) }).subtracting(requested).filter {
            force || statuses[$0] == nil
        }.sorted()
        guard !urls.isEmpty, let api = try? BoardAPI(server) else { return }
        requested.formUnion(urls)
        pending.formUnion(urls)
        guard snapshot == nil else { return }
        snapshot = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, !self.pending.isEmpty {
                let batch = Array(self.pending.sorted().prefix(50))
                self.pending.subtract(batch)
                await self.load(batch, api: api)
            }
            if !Task.isCancelled { self.snapshot = nil }
        }
    }

    private func load(_ batch: [String], api: BoardAPI) async {
        for delay in [0, 500, 2_000] {
            if delay > 0 {
                do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
            }
            guard !Task.isCancelled else { return }
            let baseline = statuses
            do {
                let values: [PullRequestStatus] = try await api.request("api/pr-info", method: "POST", body: ["urls": batch])
                guard !Task.isCancelled else { return }
                apply(values, baseline: baseline)
                return
            } catch {
                // A failed batch can recover; per-PR unavailability in a valid response waits for a push.
            }
        }
    }

    func stop() {
        snapshot?.cancel()
        snapshot = nil
        pending.removeAll()
        requested.removeAll()
    }

    func reset() {
        stop()
        statuses = [:]
    }
}
