import Foundation
import Combine

/// Uploads finish before any insertion. Generation checks prevent delivery to a replacement terminal.
@MainActor final class NativePasteController: ObservableObject {
    enum State: Equatable {
        case idle, reading, reviewing, uploading, prepared([String]), failed(String)
    }
    @Published private(set) var state: State = .idle
    @Published private(set) var insertionCount = 0
    typealias Upload = (NativePasteFile) async throws -> String
    private var upload: Upload?
    private var deliver: ((NativePasteDelivery) -> Void)?
    private var available: () -> Bool = { false }
    private var remote = false
    private var agent: () -> String? = { nil }
    private enum Request {
        case paste(NativePastePayload, immediately: Bool)
        case providers([NSItemProvider])
        case readFailure(String)
    }
    private var queued: [Request] = []
    private var generation = 0
    private var task: Task<Void, Never>?
    private var pending: NativePastePayload?
    private var paths: [String] = []
    private var immediate = false
    private var recoverable = false
    var reviewFiles: [NativePasteFile] { state == .reviewing ? pending?.files ?? [] : [] }
    var reviewText: String { state == .reviewing ? pending?.text ?? "" : "" }
    var reviewAction: String { immediate ? (reviewFiles.isEmpty ? "Insert text" : "Insert attachments") : "Upload files" }
    func confirmReview() { guard state == .reviewing else { return }; run() }
    func removeReviewFile(at index: Int) {
        guard state == .reviewing, pending?.files.indices.contains(index) == true else { return }
        objectWillChange.send()
        pending?.files.remove(at: index)
        if pending?.isEmpty == true { advance() }
    }
    var busy: Bool { state == .reading || state == .uploading }
    var canRetry: Bool { pending != nil && recoverable }

    func configure(agent: String?, currentAgent: (() -> String?)? = nil, remote: Bool, available: @escaping () -> Bool,
                   upload: @escaping Upload, deliver: @escaping (NativePasteDelivery) -> Void) {
        cancel()
        self.agent = currentAgent ?? { agent }; self.remote = remote; self.available = available
        self.upload = upload; self.deliver = deliver
    }
    func cancel() {
        generation += 1; task?.cancel(); task = nil; pending = nil; paths = []; queued = []; recoverable = false; state = .idle
    }
    func fail(_ error: Error) { cancel(); state = .failed(error.localizedDescription) }
    func pasteClipboard() {
        do { submit(try NativePastePayload.read(), immediately: true) }
        catch { enqueue(.readFailure(error.localizedDescription)) }
    }
    func submit(itemProviders: [NSItemProvider]) { enqueue(.providers(itemProviders)) }
    func submit(_ payload: NativePastePayload, immediately: Bool) { enqueue(.paste(payload, immediately: immediately)) }
    /// File/photo selections join an unsubmitted review; validation never discards its draft.
    func addAttachments(_ payload: NativePastePayload) throws {
        try payload.validate()
        guard !remote || payload.files.isEmpty else {
            throw SessionActionError(message: "File uploads are unavailable for SSH sessions.")
        }
        guard !payload.isEmpty else { return }
        if state == .reviewing, var combined = pending {
            combined.text += payload.text
            combined.files += payload.files
            try combined.validate()
            objectWillChange.send()
            pending = combined
            immediate = true
        } else if state == .idle {
            submit(payload, immediately: true)
        } else {
            throw SessionActionError(message: "Finish or dismiss the current attachment before adding more files.")
        }
    }
    private func enqueue(_ request: Request) {
        if pending != nil || state != .idle { queued.append(request); return }
        begin(request)
    }
    private func begin(_ request: Request) {
        switch request {
        case .paste(let payload, let immediately):
            pending = payload; immediate = immediately
            do {
                try payload.validate()
                if remote && !payload.files.isEmpty { throw SessionActionError(message: "File uploads are unavailable for SSH sessions.") }
                if payload.files.isEmpty { run() } else { state = .reviewing }
            } catch { state = .failed(error.localizedDescription) }
        case .readFailure(let message): state = .failed(message)
        case .providers(let providers):
            let epoch = generation
            state = .reading
            task = Task { [weak self] in
                do {
                    let payload = try await NativePastePayload.load(providers)
                    guard let self, generation == epoch, !Task.isCancelled else { return }
                    begin(.paste(payload, immediately: true))
                } catch {
                    guard let self, generation == epoch, !Task.isCancelled else { return }
                    state = .failed(error.localizedDescription)
                }
            }
        }
    }
    func dismissError() {
        guard case .failed = state else { return }
        advance()
    }
    func retry() { guard canRetry, !busy else { return }; run() }
    private func run() {
        guard let payload = pending, let upload else { return }
        recoverable = false
        guard !payload.isEmpty else { state = .failed("The clipboard is empty. Copy text, an image, or a file first."); return }
        do {
            try payload.validate()
            if remote && !payload.files.isEmpty { throw SessionActionError(message: "File uploads are unavailable for SSH sessions.") }
        } catch { state = .failed(error.localizedDescription); return }
        recoverable = true
        guard available() else { state = .failed("Reconnect to the terminal before retrying paste."); return }
        let epoch = generation
        state = .uploading
        task = Task { [weak self] in
            guard let self else { return }
            do {
                // Retain completed uploads when retrying the remaining files.
                for file in payload.files.dropFirst(paths.count) {
                    let path = try await upload(file)
                    guard generation == epoch, !Task.isCancelled else { return }
                    guard available() else { throw SessionActionError(message: "The terminal disconnected. Reconnect before retrying paste.") }
                    guard path.hasPrefix("/") else { throw SessionActionError(message: "The server returned an invalid uploaded file path.") }
                    paths.append(path)
                }
                guard generation == epoch, !Task.isCancelled else { return }
                guard available() else { throw SessionActionError(message: "The terminal disconnected. Reconnect before retrying paste.") }
                state = .prepared(paths)
                if immediate { insert() }
            } catch {
                guard generation == epoch, !Task.isCancelled else { return }
                state = .failed(error.localizedDescription)
            }
        }
    }
    func insert() {
        guard case .prepared = state, let pending, available() else { return }
        for message in NativePasteDelivery.make(pending, paths: paths, agent: agent()) { deliver?(message) }
        insertionCount += 1
        advance()
    }
    private func advance() {
        pending = nil; paths = []; task = nil; recoverable = false; state = .idle
        if !queued.isEmpty { begin(queued.removeFirst()) }
    }
}
