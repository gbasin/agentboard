import Foundation

/// The same base URL used to open Agentboard in a browser, including a proxy prefix.
struct ServerAddress: Equatable {
    let baseURL: URL
    init(_ value: String) throws {
        guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else {
            throw AddressError.invalid
        }
        parts.scheme = parts.scheme?.lowercased()
        while parts.path.hasSuffix("/") { parts.path.removeLast() }
        guard let url = parts.url else { throw AddressError.invalid }
        baseURL = url
    }
    var socketURL: URL {
        var parts = URLComponents(url: baseURL.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)!
        parts.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "catalog", value: "2")]
        return parts.url!
    }
    enum AddressError: LocalizedError {
        case invalid
        var errorDescription: String? { "Enter an http:// or https:// server address without credentials, a query, or a fragment." }
    }
}
