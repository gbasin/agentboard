import Foundation

/// Tracks only text committed in this keyboard context. Controls and focus changes
/// discard it so replacements cannot erase text entered by another input path.
struct TerminalEditBuffer {
    private(set) var committed = ""
    mutating func reset() { committed = "" }
    mutating func seed(_ value: String) { committed = value }
    mutating func replace(with value: String) -> String {
        let before = Array(committed.unicodeScalars), after = Array(value.unicodeScalars)
        var common = 0
        while common < min(before.count, after.count), before[common] == after[common] { common += 1 }
        committed = value
        let inserted = String(String.UnicodeScalarView(after.dropFirst(common))).replacingOccurrences(of: "\n", with: "\r")
        // Match the PWA replacement path: bracket corrections so agent CLIs do
        // not mistake the following explicit Return for a paste-burst newline.
        let replacement = common < before.count && !inserted.isEmpty && !inserted.contains("\r")
        return String(repeating: "\u{7f}", count: before.count - common)
            + (replacement ? "\u{1b}[200~" + inserted + "\u{1b}[201~" : inserted)
    }
}
