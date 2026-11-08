import SwiftUI

/// Dismiss only the interruptions/errors the user has seen, independently per server.
@MainActor
final class RecoveryNoticeModel: ObservableObject {
    struct Dismissed: Codable { var ids: [String] = []; var error: String? }
    @Published private(set) var health: LibraryHealth?
    @Published private(set) var dismissed = Dismissed()
    private let defaults: UserDefaults
    private var server = ""
    private var generation = UUID()
    private var key: String { "recovery-notice." + server }
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var pendingIDs: [String] {
        let ids = health?.interruptedIds ?? ((health?.interrupted ?? 0) > 0 ? ["*"] : [])
        return ids.filter { !dismissed.ids.contains($0) }
    }
    var pendingCount: Int { pendingIDs == ["*"] ? health?.interrupted ?? 0 : pendingIDs.count }
    var hasError: Bool { !(health?.error ?? "").isEmpty && health?.error != dismissed.error }
    var visible: Bool { !pendingIDs.isEmpty || hasError }

    func configure(_ value: String) {
        guard value != server else { return }
        server = value; generation = UUID(); health = nil
        dismissed = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Dismissed.self, from: $0) } ?? Dismissed()
    }
    func refresh(_ value: String, fetch: ((String) async throws -> LibraryHealth)? = nil) async {
        configure(value)
        guard !value.isEmpty else { return }
        let token = UUID(); generation = token
        do {
            let next: LibraryHealth
            if let fetch { next = try await fetch(value) }
            else { next = try await BoardAPI(value).request("api/library/health") }
            guard generation == token, server == value, !Task.isCancelled else { return }
            health = next
        } catch { /* Keep recovery evidence during a transient health-request failure. */ }
    }
    func dismiss() {
        dismissed = Dismissed(ids: health?.interruptedIds ?? pendingIDs, error: health?.error)
        if let data = try? JSONEncoder().encode(dismissed) { defaults.set(data, forKey: key) }
    }
}

struct RecoveryNoticeView: View {
    let open: () -> Void
    @ObservedObject var model: RecoveryNoticeModel
    var body: some View {
        Group {
            if model.visible {
                Section {
                    HStack(spacing: 8) {
                        Button(action: open) {
                            Label {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(model.pendingCount > 0
                                         ? "\(model.pendingCount) interrupted session\(model.pendingCount == 1 ? "" : "s") saved"
                                         : "Session recovery needs attention")
                                        .font(.subheadline.weight(.semibold))
                                    Text("Review in Library").font(.caption).foregroundStyle(.secondary)
                                }.foregroundStyle(Color.primary)
                            } icon: { Image(systemName: "exclamationmark.arrow.circlepath").foregroundStyle(.orange) }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("recovery-notice")
                        Button { model.dismiss() } label: {
                            Image(systemName: "xmark.circle.fill").font(.title3).foregroundStyle(.secondary)
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("Dismiss recovery notice")
                            .accessibilityHint("Hides this reminder. Saved sessions remain in Library.")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6).nativeGlassSurface()
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
            }
        }
    }
}
