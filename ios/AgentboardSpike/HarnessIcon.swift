import SwiftUI

/// The same marks and prefix matching as the web client's AgentIcon.tsx.
/// Assets retain the web viewBoxes; oh-my-pi retains its orange connector.
struct HarnessIcon: View {
    let agent: String?
    @ScaledMetric(relativeTo: .headline) private var size = 18

    private var key: String? {
        let value = (agent ?? "").lowercased()
        return ["claude", "codex", "omp", "pi", "devin", "grok"].first { value.hasPrefix($0) }
    }
    private var name: String {
        switch key {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "omp": return "Oh My Pi"
        case "pi": return "Pi"
        case "devin": return "Devin"
        case "grok": return "Grok"
        default: return agent.flatMap { $0.isEmpty ? nil : $0 } ?? "Shell"
        }
    }
    var body: some View {
        Group {
            if let key {
                Image("Harness-\(key)").resizable().scaledToFit()
            } else {
                Image(systemName: "terminal").resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .foregroundStyle(.secondary)
        .accessibilityLabel(name)
    }
}
