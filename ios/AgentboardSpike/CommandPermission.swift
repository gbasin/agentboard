import Foundation
import JavaScriptCore

/// The same command flag rules as NewSessionModal in the PWA.
enum CommandPermission {
    struct State: Decodable { let available: Bool; let enabled: Bool; let conflict: String? }
    private static func context() -> JSContext? {
        guard let url = Bundle.main.url(forResource: "native-transcript", withExtension: "js", subdirectory: "Web/vendor"),
              let script = try? String(contentsOf: url, encoding: .utf8), let context = JSContext() else { return nil }
        context.evaluateScript(script); return context
    }
    static func state(_ command: String) -> State {
        guard let value = context()?.objectForKeyedSubscript("commandPermission")?.call(withArguments: [command])?.toString(),
              let state = try? JSONDecoder().decode(State.self, from: Data(value.utf8)) else { return .init(available: false, enabled: false, conflict: nil) }
        return state
    }
    static func set(_ command: String, enabled: Bool) -> String {
        context()?.objectForKeyedSubscript("setCommandPermission")?.call(withArguments: [command, enabled])?.toString() ?? command
    }
}
