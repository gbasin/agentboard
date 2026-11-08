import SwiftUI
import JavaScriptCore

struct TerminalSnapshotReply: Decodable {
    let sessionId: String
    let requestId: Int
    let ok: Bool
    let text: String?
    let altScreen: Bool?
    let historyLines: Int?
    let scrollPosition: Int?
}

/// One outstanding request, fenced by session and monotonically increasing request ID.
@MainActor final class TerminalSnapshotRequest {
    private var sequence = 0
    private var pending: (id: Int, session: String, continuation: CheckedContinuation<TerminalSnapshotReply, Error>)?
    func capture(session: String, send: (Int) -> Void) async throws -> TerminalSnapshotReply {
        cancel(); sequence += 1; let id = sequence
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                pending = (id, session, continuation); send(id)
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(15))
                    guard self?.pending?.id == id else { return }
                    self?.cancel(SessionActionError(message: "The snapshot timed out. Check the connection and retry."))
                }
            }
        } onCancel: { Task { @MainActor [weak self] in if self?.pending?.id == id { self?.cancel() } } }
    }
    func receive(_ reply: TerminalSnapshotReply) {
        guard let pending, reply.requestId == pending.id, reply.sessionId == pending.session else { return }
        self.pending = nil
        guard reply.ok, let text = reply.text, text.utf8.count <= 8 * 1024 * 1024 else {
            pending.continuation.resume(throwing: SessionActionError(message: "This server could not capture the terminal. Retry or update the server.")); return
        }
        pending.continuation.resume(returning: reply)
    }
    func cancel(_ error: Error = CancellationError()) {
        let old = pending; pending = nil; old?.continuation.resume(throwing: error)
    }
}

/// Shares the PWA's tested selection normalization and TUI wrap heuristics.
enum SnapshotCopy {
    static func text(_ text: String, range: NSRange, columns: Int, rejoin: Bool) -> String {
        guard let url = Bundle.main.url(forResource: "native-transcript", withExtension: "js", subdirectory: "Web/vendor"),
              let script = try? String(contentsOf: url, encoding: .utf8), let context = JSContext() else { return (text as NSString).substring(with: range) }
        context.evaluateScript(script)
        return context.objectForKeyedSubscript("snapshotCopy")?.call(withArguments: [text, range.location, range.length, columns, rejoin])?.toString() ?? (text as NSString).substring(with: range)
    }
}

struct TerminalSelectionView: View {
    @ObservedObject var board: BoardConnection
    let session: BoardSession
    @State private var snapshot: TerminalSnapshotReply?
    @State private var error: String?
    @State private var revision = 0
    @State private var loading = false
    @State private var selection = NSRange(location: 0, length: 0)
    @Environment(\.dismiss) private var dismiss
    private var text: String { snapshot?.text ?? "" }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let error { ErrorRow(message: error) { revision += 1 }.padding() }
                if loading { ProgressView("Capturing terminal…").padding() }
                if let snapshot {
                    SnapshotSelectableText(text: text, revision: snapshot.requestId, scrollPosition: snapshot.scrollPosition ?? 0, selection: $selection) { range in copy(range) }
                    Text(snapshot.altScreen == true ? "Frozen screen" : "Frozen screen and scrollback")
                        .accessibilityHint("Refresh to capture new terminal output")
                        .font(.caption).foregroundStyle(.secondary).padding(8)
                }
            }
            .navigationTitle("Select text").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button("Refresh", systemImage: "arrow.clockwise") { revision += 1 }.disabled(loading)
                    Spacer()
                    Button("Copy selection", systemImage: "doc.on.doc") { copy(selection) }.disabled(selection.length == 0)
                    Button("Copy all") { copy(NSRange(location: 0, length: (text as NSString).length)) }.disabled(text.isEmpty)
                }
            }
            .task(id: revision) {
                loading = true; error = nil
                do {
                    // Match the PWA: allow keyboard dismissal and the resulting pane resize to settle.
                    if snapshot == nil { try await Task.sleep(for: .milliseconds(600)) }
                    snapshot = try await board.captureSnapshot(sessionID: session.id); selection = NSRange(location: 0, length: 0)
                } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                loading = false
            }
        }
    }
    private func copy(_ range: NSRange) {
        guard range.length > 0, range.location >= 0, NSMaxRange(range) <= (text as NSString).length else { return }
        UIPasteboard.general.string = SnapshotCopy.text(text, range: range, columns: board.terminalColumns,
            rejoin: snapshot?.altScreen == true || session.agent != "Shell")
        dismiss()
    }
}

private struct SnapshotSelectableText: UIViewRepresentable {
    let text: String
    let revision: Int
    let scrollPosition: Int
    @Binding var selection: NSRange
    let copy: (NSRange) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> SelectionTextView {
        let view = SelectionTextView()
        view.isEditable = false; view.isSelectable = true
        view.backgroundColor = .systemBackground; view.textColor = .label
        view.font = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular)
        view.adjustsFontForContentSizeCategory = true; view.dataDetectorTypes = [.link]
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        view.delegate = context.coordinator; view.accessibilityIdentifier = "terminal-snapshot-text"
        return view
    }
    func updateUIView(_ view: SelectionTextView, context: Context) {
        context.coordinator.parent = self; view.copyText = copy
        if view.text != text || view.revision != revision {
            view.revision = revision
            view.text = text
            view.selectedRange = NSRange(location: (text as NSString).length, length: 0)
            view.pendingScrollPosition = scrollPosition
            view.setNeedsLayout()
        }
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SnapshotSelectableText
        init(_ parent: SnapshotSelectableText) { self.parent = parent }
        func textViewDidChangeSelection(_ textView: UITextView) { parent.selection = textView.selectedRange }
    }
}
private final class SelectionTextView: UITextView {
    var copyText: ((NSRange) -> Void)?
    var revision: Int?
    var pendingScrollPosition: Int?
    override func layoutSubviews() {
        super.layoutSubviews()
        guard window != nil, bounds.width > 0, bounds.height > 0, let position = pendingScrollPosition else { return }
        pendingScrollPosition = nil
        let expectedRevision = revision
        DispatchQueue.main.async { [weak self] in
            guard let self, revision == expectedRevision else { return }
            layoutIfNeeded()
            let lines = (text ?? "").components(separatedBy: "\n")
            let prefix = lines.prefix(max(1, lines.count - max(0, position))).joined(separator: "\n")
            let length = (prefix as NSString).length
            scrollRangeToVisible(NSRange(location: max(0, length - 1), length: min(1, length)))
        }
    }
    override func copy(_ sender: Any?) { copyText?(selectedRange) }
}
