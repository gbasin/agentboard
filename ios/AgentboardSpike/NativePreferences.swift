import SwiftUI
import AudioToolbox

/// JSON values preserve unknown shared settings without inventing native state flags.
enum JSONValue: Codable, Equatable {
    case string(String), bool(Bool), number(Double), array([JSONValue]), object([String: JSONValue]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    var string: String? { if case .string(let v) = self { v } else { nil } }
    var bool: Bool? { if case .bool(let v) = self { v } else { nil } }
    var strings: [String]? { if case .array(let v) = self { v.compactMap(\.string) } else { nil } }
}

@MainActor
final class NativePreferences: ObservableObject {
    @Published var shared: [String: JSONValue] = [:]
    @Published var error: String?
    @Published private(set) var pendingWrites = 0
    var saving: Bool { pendingWrites > 0 }
    struct Response: Decodable { let settings: [String: JSONValue] }
    private var writes: Task<Void, Never>?
    var serverURL = ""
    func string(_ key: String, _ fallback: String = "") -> String { shared[key]?.string ?? fallback }
    func bool(_ key: String, _ fallback: Bool = false) -> Bool { shared[key]?.bool ?? fallback }
    func strings(_ key: String) -> [String] { shared[key]?.strings ?? [] }
    var presets: [CommandPreset] {
        guard let value = shared["commandPresets"], let data = try? JSONEncoder().encode(value),
              let presets = try? JSONDecoder().decode([CommandPreset].self, from: data) else { return CommandPreset.defaults }
        return presets
    }
    func set(_ key: String, _ value: JSONValue) {
        let server = serverURL
        let prior = writes
        pendingWrites += 1
        writes = Task { @MainActor in
            defer { pendingWrites -= 1 }
            await prior?.value
            guard serverURL == server else { return }
            do {
                let encoded = try JSONEncoder().encode(value)
                let object = try JSONSerialization.jsonObject(with: encoded, options: .fragmentsAllowed)
                let result: Response = try await BoardAPI(server).request("api/settings/synced", method: "PUT", body: ["settings": [key: object]])
                guard serverURL == server else { return }
                shared.merge(result.settings) { _, new in new }; error = nil
            } catch { if serverURL == server { self.error = error.localizedDescription } }
        }
    }
    func savePresets(_ presets: [CommandPreset]) {
        if !presets.contains(where: { $0.id == string("defaultPresetId") }) {
            set("defaultPresetId", .string(presets.first?.id ?? ""))
        }
        if let data = try? JSONEncoder().encode(presets), let value = try? JSONDecoder().decode(JSONValue.self, from: data) { set("commandPresets", value) }
    }
    func remember(_ path: String) {
        set("lastProjectPath", .string(path))
        set("recentPaths", .array(Array(([path] + strings("recentPaths").filter { $0 != path }).prefix(50)).map(JSONValue.string)))
    }
    func binding(_ key: String, fallback: Bool = false) -> Binding<Bool> {
        Binding(get: { self.bool(key, fallback) }, set: { self.set(key, .bool($0)) })
    }
    func selection(_ key: String, fallback: String = "") -> Binding<String> {
        Binding(get: { self.string(key, fallback) }, set: { self.set(key, .string($0)) })
    }
    static func sound(permission: Bool) { AudioServicesPlaySystemSound(permission ? 1057 : 1025) }
}
