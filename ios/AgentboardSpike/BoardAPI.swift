import Foundation

/// HTTP companion to the live socket. Mutations are sent once, never retried.
struct BoardAPI {
    let address: ServerAddress
    init(_ value: String) throws { address = try ServerAddress(value) }
    func url(_ path: String, query: [String: String] = [:]) -> URL {
        var parts = URLComponents(url: address.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query.sorted { $0.key < $1.key }.map { .init(name: $0.key, value: $0.value) } }
        return parts.url!
    }
    func request<T: Decodable>(_ path: String, method: String = "GET", query: [String: String] = [:], body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: url(path, query: query)); request.httpMethod = method; request.timeoutInterval = 20
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch {
            if method == "GET" { throw error }
            throw SessionActionError(message: "The result could not be confirmed. Refresh before retrying; the server may have completed the change.")
        }
        try Self.check(data, response)
        return try JSONDecoder().decode(T.self, from: data)
    }
    static func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw SessionActionError(message: error?["message"] as? String ?? error?["error"] as? String ?? "Server request failed.")
        }
    }
    func upload(_ data: Data, name: String, mime: String = "application/octet-stream") async throws -> String {
        guard data.count <= 40 * 1024 * 1024 else { throw SessionActionError(message: "File exceeds the 40 MB limit.") }
        let image = ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime)
        let field = image ? "image" : "file"
        let boundary = UUID().uuidString
        let safeName = name.filter { !$0.isNewline && $0 != "\"" && $0 != "\\" }
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: url(image ? "api/paste-image" : "api/paste-file")); request.httpMethod = "POST"; request.timeoutInterval = 60
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (responseData, response) = try await URLSession.shared.upload(for: request, from: body)
        try Self.check(responseData, response)
        return try JSONDecoder().decode(UploadedFile.self, from: responseData).path
    }
    struct UploadedFile: Decodable { let path: String }
    static func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}
struct EmptyResponse: Decodable {}
struct DirectoryPage: Decodable {
    struct Entry: Decodable, Identifiable { let name: String; let path: String; var id: String { path } }
    let path: String; let parent: String?; let directories: [Entry]; let truncated: Bool
}
struct CommandPreset: Codable, Identifiable, Equatable {
    var id: String; var label: String; var command: String; var isBuiltIn: Bool; var agentType: String?
    static let defaults: [Self] = [
        .init(id: "claude", label: "Claude", command: "claude", isBuiltIn: true, agentType: "claude"),
        .init(id: "codex", label: "Codex", command: "codex", isBuiltIn: true, agentType: "codex"),
        .init(id: "shell", label: "Shell", command: "/bin/zsh", isBuiltIn: true)]
}
struct MediaItem: Decodable, Hashable, Identifiable {
    let kind: String; let url: String; let mediaType: String?; let bytes: Int?; let label: String?
    var externalUrl: String? = nil
    var sourceText: String? = nil
    var id: String { url }
}
struct PullRequestItem: Decodable, Hashable, Identifiable {
    let url: String; let repo: String; let number: Int
    var id: String { url }
}
struct AgentLogSession: Decodable, Identifiable, Hashable {
    let sessionId: String; let displayName: String; let projectPath: String; let agentType: String
    let lastActivityAt: String; let lastUserMessage: String?; let isHibernating: Bool?; let lastResumeError: String?
    let prs: [PullRequestItem]?; let media: [MediaItem]?
    var mediaSummary: MediaCatalogSummary? = nil
    var host: String? = nil
    var id: String { sessionId }
}
struct HostState: Decodable, Identifiable { let host: String; let ok: Bool; let error: String?; var id: String { host } }
struct SavedSession: Decodable, Identifiable, Hashable {
    let id: String; let name: String; let projectPath: String; let agentType: String?; let providerId: String?
    let command: String; let state: String; let pinned: Bool; let lastActivityAt: String; let error: String?; let preview: String?
}
struct HistoryPage: Decodable { let sessions: [SavedSession]; let nextCursor: String? }
struct HistoryDetail: Decodable {
    struct Event: Decodable, Identifiable { let id: Int; let kind: String; let detail: String?; let createdAt: String }
    let session: SavedSession; let terminalPreview: String?; let events: [Event]; let conversations: [AgentLogSession]
}
struct LibraryHealth: Decodable {
    var interruptedIds: [String]? = nil
    struct Settings: Decodable { let autoResume: Bool; let capturePreviews: Bool }
    let interrupted: Int; let error: String?; let matchingAvailable: Bool; let matchingError: String?; let settings: Settings
}
