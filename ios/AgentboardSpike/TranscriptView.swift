import SwiftUI
import JavaScriptCore

struct TranscriptPage: Decodable {
    let lines: [String]; let hasMoreBefore: Bool; let startLine: Int; let startByte: Int?
}
struct TranscriptEntry: Decodable, Identifiable { let id: String; let role: String; let kind: String; let text: String }
enum TranscriptParser {
    static func entries(_ lines: [String]) -> [TranscriptEntry] {
        guard let url = Bundle.main.url(forResource: "native-transcript", withExtension: "js", subdirectory: "Web/vendor"),
              let script = try? String(contentsOf: url, encoding: .utf8), let context = JSContext() else { return [] }
        context.evaluateScript(script)
        guard let json = context.objectForKeyedSubscript("normalizeTranscript")?.call(withArguments: [lines])?.toString(),
              let entries = try? JSONDecoder().decode([TranscriptEntry].self, from: Data(json.utf8)) else { return [] }
        var result: [TranscriptEntry] = []
        for entry in entries where !entry.text.isEmpty {
            if let last = result.last, last.role == entry.role, last.kind == "message", entry.kind == "message", last.text == entry.text { continue }
            result.append(entry)
        }
        return result.reversed()
    }
}
struct TranscriptView: View {
    let server: String
    let sessionID: String
    let title: String
    @State private var lines: [String] = []
    @State private var entries: [TranscriptEntry] = []
    @State private var page: TranscriptPage?
    @State private var events = false
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        List {
            Picker("View", selection: $events) { Text("Messages").tag(false); Text("Events").tag(true) }.pickerStyle(.segmented)
            if let error { ErrorRow(message: error) { Task { await load() } } }
            if events {
                ForEach(Array(lines.enumerated().reversed()), id: \.offset) { index, line in
                    DisclosureGroup("Entry \(index + 1)") { Text(line).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }
            } else {
                ForEach(entries) { entry in
                    Section(entry.role.capitalized) {
                        if entry.kind == "tool_call" || entry.kind == "tool_result" {
                            DisclosureGroup(entry.kind == "tool_call" ? "Tool call" : "Tool result") { Text(entry.text).textSelection(.enabled) }
                        } else { Text(.init(entry.text)).textSelection(.enabled) }
                    }
                }
                if entries.isEmpty && !loading && error == nil { Text("No readable messages. Try Events.").foregroundStyle(.secondary) }
            }
            if loading { ProgressView("Loading transcript…") }
        }.navigationTitle("Transcript").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .primaryAction) {
                if page?.hasMoreBefore == true { Button("Load earlier") { Task { await load(earlier: true) } }.disabled(loading) }
            } }
            .task(id: sessionID) { await load() }.refreshable { await load() }
    }
    private func load(earlier: Bool = false) async {
        guard !loading else { return }; loading = true; defer { loading = false }
        do {
            var query = ["limit": "200"]
            if earlier, let page {
                if let start = page.startByte { query["beforeByte"] = String(start) } else { query["beforeLine"] = String(page.startLine) }
            }
            let result: TranscriptPage = try await BoardAPI(server).request("api/session-preview/\(sessionID)", query: query)
            lines = earlier ? result.lines + lines : result.lines
            page = result; entries = TranscriptParser.entries(lines); error = nil
        } catch { self.error = error.localizedDescription }
    }
}
