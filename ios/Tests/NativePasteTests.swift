import XCTest
import UIKit
import UniformTypeIdentifiers
import CryptoKit
@testable import AgentboardSpike

@MainActor final class NativePasteTests: XCTestCase {
    let image = NativePasteFile(data: Data([1, 2, 3]), name: "image.png", mime: "image/png")
    let document = NativePasteFile(data: Data("document".utf8), name: "note.txt", mime: "text/plain")
    private func settle(_ predicate: () -> Bool) async throws {
        for _ in 0..<100 { if predicate() { return }; try await Task.sleep(for: .milliseconds(10)) }
        XCTFail("Paste did not reach expected state")
    }
    func testFileAndPhotoSelectionsJoinReviewAndInsertOnceWithoutEnter() async throws {
        let controller = NativePasteController()
        var deliveries: [NativePasteDelivery] = []
        controller.configure(agent: "codex", remote: false, available: { true },
                             upload: { "/tmp/" + $0.name }, deliver: { deliveries.append($0) })
        try controller.addAttachments(.init(files: [document]))
        try controller.addAttachments(.init(files: [image]))
        XCTAssertEqual(controller.reviewFiles, [document, image])
        XCTAssertEqual(controller.reviewAction, "Insert attachments")
        XCTAssertTrue(deliveries.isEmpty)
        XCTAssertThrowsError(try controller.addAttachments(.init(files: [.init(data: Data(), name: "bad.png", mime: "image/png")])))
        XCTAssertEqual(controller.reviewFiles, [document, image], "Invalid additions preserve the draft")
        controller.confirmReview()
        try await settle { controller.state == .idle }
        XCTAssertEqual(controller.insertionCount, 1)
        XCTAssertEqual(deliveries, [.init(value: "'/tmp/note.txt' ", bracketed: true), .init(value: "/tmp/image.png ", bracketed: false)])
    }
    func testMixedDeliveryMatchesPWAAndNeverAddsEnter() {
        let payload = NativePastePayload(text: "review", files: [image, document, image])
        let paths = ["/tmp/one.png", "/tmp/a'b\n.txt", "/tmp/two\u{1b}.png"]
        XCTAssertEqual(NativePasteDelivery.make(payload, paths: paths, agent: "claude"), [
            .init(value: "review\n'/tmp/a'\\''b.txt' ", bracketed: true),
            .init(value: "\u{1b}[200~/tmp/one.png\u{1b}[201~ ", bracketed: false),
            .init(value: "\u{1b}[200~/tmp/two.png\u{1b}[201~ ", bracketed: false)])
        XCTAssertEqual(NativePasteDelivery.make(.init(files: [image]), paths: ["/tmp/one.png"], agent: "codex"), [.init(value: "/tmp/one.png ", bracketed: false)])
        XCTAssertEqual(NativePasteDelivery.make(.init(text: "one\ntwo"), paths: [], agent: nil), [.init(value: "one\ntwo", bracketed: true)])
    }
    func testActualPasteboardMultipleItemsAndAlternateImages() throws {
        let name = UIPasteboard.Name("dev.agentboard.tests.\(UUID())")
        let board = try XCTUnwrap(UIPasteboard(name: name, create: true))
        defer { UIPasteboard.remove(withName: name) }
        board.items = [[UTType.utf8PlainText.identifier: "review"],
                       [UTType.png.identifier: image.data, UTType.jpeg.identifier: Data([4])],
                       [UTType.pdf.identifier: Data("pdf".utf8)]]
        let value = try NativePastePayload.read(board)
        XCTAssertEqual(value.text, "review")
        XCTAssertEqual(value.files.count, 2)
        XCTAssertEqual(value.files[0].mime, "image/png")
        XCTAssertEqual(value.files[1].mime, "application/pdf")
    }
    func testImageOnlyPasteIsAvailableThroughNativeEditMenu() {
        // Tests run on the isolated Simulator; do not read/preserve the user's clipboard.
        UIPasteboard.general.items = [[UTType.png.identifier: image.data]]
        defer { UIPasteboard.general.items = [] }
        let terminal = TerminalBridge()
        let input = TerminalInputView(terminal: terminal)
        XCTAssertTrue(input.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
        UIPasteboard.general.items = []
        XCTAssertFalse(input.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
    }
    func testUIImageRepresentationBecomesOnePNG() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        let value = try NativePastePayload.decode([["com.apple.uikit.image": image, UTType.utf8PlainText.identifier: "alternate image label"]])
        XCTAssertEqual(value.files.count, 1)
        XCTAssertEqual(value.files.first?.mime, "image/png")
        XCTAssertEqual(value.text, "")
    }
    func testDisconnectDuringUploadLeavesRecoverableFailure() async throws {
        let controller = NativePasteController()
        var pending: CheckedContinuation<String, Error>?
        var available = true
        var deliveries = 0
        controller.configure(agent: "claude", remote: false, available: { available }, upload: { _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        }, deliver: { _ in deliveries += 1 })
        controller.submit(.init(files: [image]), immediately: true)
        controller.confirmReview()
        try await settle { pending != nil }
        available = false
        pending?.resume(returning: "/tmp/image.png")
        try await settle { if case .failed = controller.state { return true }; return false }
        XCTAssertFalse(controller.busy)
        controller.retry()
        guard case .failed(let message) = controller.state else { return XCTFail("Disconnected retry needs feedback") }
        XCTAssertTrue(message.contains("Reconnect"))
        XCTAssertEqual(deliveries, 0)
    }
    func testClipboardFileURLAndUnsupportedPrivateItem() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("clipboard-test-\(UUID()).txt")
        try document.data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let payload = try NativePastePayload.decode([[UTType.fileURL.identifier: url.absoluteString]])
        XCTAssertEqual(payload.files.first?.data, document.data)
        XCTAssertEqual(payload.files.first?.mime, "text/plain")
        XCTAssertThrowsError(try NativePastePayload.decode([["com.apple.DocumentManager.private": Data([1])]]))
    }
    func testRetryCompletesRemainingUploadsBeforeSingleDelivery() async throws {
        let controller = NativePasteController()
        var calls: [String] = [], deliveries: [NativePasteDelivery] = []
        var failed = false
        controller.configure(agent: "claude", remote: false, available: { true }, upload: { file in
            calls.append(file.name)
            if file.name == "note.txt" && !failed { failed = true; throw URLError(.networkConnectionLost) }
            return "/tmp/\(file.name)"
        }, deliver: { deliveries.append($0) })
        controller.submit(.init(text: "review", files: [image, document]), immediately: true)
        controller.confirmReview()
        try await settle { if case .failed = controller.state { return true }; return false }
        XCTAssertTrue(deliveries.isEmpty)
        controller.retry()
        try await settle { controller.state == .idle }
        XCTAssertEqual(calls, ["image.png", "note.txt", "note.txt"])
        XCTAssertEqual(deliveries.count, 2)
        XCTAssertTrue(deliveries[0].bracketed)
        XCTAssertFalse(deliveries[1].bracketed)
    }
    func testCancelDiscardsLateUploadAfterTerminalReplacement() async throws {
        let controller = NativePasteController()
        var pending: CheckedContinuation<String, Error>?
        var deliveries: [NativePasteDelivery] = []
        controller.configure(agent: "claude", remote: false, available: { true }, upload: { _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        }, deliver: { deliveries.append($0) })
        controller.submit(.init(files: [image]), immediately: true)
        controller.confirmReview()
        try await settle { pending != nil }
        controller.cancel()
        pending?.resume(returning: "/tmp/stale.png")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(controller.state, .idle)
        XCTAssertTrue(deliveries.isEmpty)
    }
    func testRemoteUploadBlockedAndPreparedFilesRequireExplicitInsert() async throws {
        let controller = NativePasteController()
        var calls = 0, deliveries = 0
        let upload: NativePasteController.Upload = { file in calls += 1; return "/tmp/\(file.name)" }
        controller.configure(agent: "codex", remote: true, available: { true }, upload: upload, deliver: { _ in deliveries += 1 })
        controller.submit(.init(files: [document]), immediately: true)
        controller.confirmReview()
        guard case .failed = controller.state else { return XCTFail("Remote file upload must be blocked") }
        XCTAssertEqual(calls, 0)
        controller.configure(agent: "codex", remote: false, available: { true }, upload: upload, deliver: { _ in deliveries += 1 })
        controller.submit(.init(files: [document]), immediately: false)
        controller.confirmReview()
        try await settle { if case .prepared = controller.state { return true }; return false }
        XCTAssertEqual(deliveries, 0)
        controller.insert()
        XCTAssertEqual(deliveries, 1)
        controller.insert()
        XCTAssertEqual(deliveries, 1)
    }
    func testImageAndTextUseDistinctWireMessagesForOwnedTerminal() async throws {
        let socket = BoardConnectionTests.Socket()
        let board = BoardConnection { _ in socket }
        defer { board.suspend(); socket.finish() }
        board.configure("http://localhost:4151")
        let owner = UUID()
        board.select("one", owner: owner, size: .init(cols: 40, rows: 20), output: { _ in }, reset: {}, status: { _ in })
        socket.emit(#"{"type":"sessions","sessions":[{"id":"one","name":"One","projectPath":"/tmp","status":"working"}]}"#)
        socket.emit(#"{"type":"terminal-ready","sessionId":"one"}"#)
        try await settle { board.terminalState == .ready }
        let controller = NativePasteController()
        controller.configure(agent: "claude", remote: false, available: { board.terminalState == .ready },
            upload: { _ in "/tmp/image.png" },
            deliver: { board.input($0.value, owner: owner, paste: $0.bracketed) })
        controller.submit(.init(text: "review", files: [image]), immediately: true)
        controller.confirmReview()
        try await settle { socket.sent.filter { ["terminal-input", "terminal-paste"].contains($0["type"] as? String ?? "") }.count == 2 }
        let messages = socket.sent.filter { ["terminal-input", "terminal-paste"].contains($0["type"] as? String ?? "") }
        XCTAssertEqual(messages.map { $0["sessionId"] as? String }, ["one", "one"])
        XCTAssertEqual(messages.map { $0["type"] as? String }, ["terminal-paste", "terminal-input"])
        XCTAssertEqual(messages.map { $0["data"] as? String }, ["review ", "\u{1b}[200~/tmp/image.png\u{1b}[201~ "])
    }
    func testQueuedMixedPastesPreserveOrderAndUseCurrentAgent() async throws {
        let controller = NativePasteController()
        var pending: CheckedContinuation<String, Error>?
        var currentAgent = "Shell"
        var uploads: [String] = [], delivered: [NativePasteDelivery] = []
        controller.configure(agent: "Shell", currentAgent: { currentAgent }, remote: false, available: { true }, upload: { file in
            uploads.append(file.name)
            if uploads.count == 1 { return try await withCheckedThrowingContinuation { pending = $0 } }
            return "/tmp/second.png"
        }, deliver: { delivered.append($0) })
        controller.submit(.init(text: "first", files: [image]), immediately: true)
        controller.confirmReview()
        controller.submit(.init(text: "second", files: [image]), immediately: true)
        controller.confirmReview()
        try await settle { pending != nil }
        XCTAssertEqual(uploads.count, 1)
        currentAgent = "codex"
        pending?.resume(returning: "/tmp/first.png")
        try await settle { controller.state == .reviewing }
        controller.confirmReview()
        try await settle { delivered.count == 4 }
        XCTAssertEqual(delivered, [.init(value: "first ", bracketed: true), .init(value: "/tmp/first.png ", bracketed: false),
                                   .init(value: "second ", bracketed: true), .init(value: "/tmp/second.png ", bracketed: false)])
        XCTAssertEqual(uploads.count, 2)
    }
    func testFailedPastePausesQueueUntilRetryAndCancelDiscardsQueue() async throws {
        let controller = NativePasteController()
        var failed = false, delivered: [String] = []
        controller.configure(agent: "codex", remote: false, available: { true }, upload: { _ in
            if !failed { failed = true; throw URLError(.cannotConnectToHost) }
            return "/tmp/first.png"
        }, deliver: { delivered.append($0.value) })
        controller.submit(.init(files: [image]), immediately: true)
        controller.confirmReview()
        controller.submit(.init(text: "second"), immediately: true)
        try await settle { if case .failed = controller.state { return true }; return false }
        XCTAssertTrue(delivered.isEmpty)
        controller.retry()
        try await settle { delivered.count == 2 }
        XCTAssertEqual(delivered, ["/tmp/first.png ", "second"])
        failed = false; delivered = []
        controller.submit(.init(files: [image]), immediately: true)
        controller.confirmReview()
        controller.submit(.init(text: "discarded"), immediately: true)
        try await settle { if case .failed = controller.state { return true }; return false }
        controller.cancel()
        controller.retry()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(delivered.isEmpty)
    }
    func testUnsupportedSecondClipboardDoesNotCancelFirstUpload() async throws {
        let controller = NativePasteController()
        var pending: CheckedContinuation<String, Error>?
        var delivered: [String] = []
        controller.configure(agent: "codex", remote: false, available: { true }, upload: { _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        }, deliver: { delivered.append($0.value) })
        controller.submit(.init(files: [image]), immediately: true)
        controller.confirmReview()
        try await settle { pending != nil }
        UIPasteboard.general.items = [["com.apple.DocumentManager.private": Data([1])]]
        defer { UIPasteboard.general.items = [] }
        controller.pasteClipboard()
        controller.submit(.init(text: "third"), immediately: true)
        pending?.resume(returning: "/tmp/first.png")
        try await settle { if case .failed = controller.state { return true }; return false }
        XCTAssertEqual(delivered, ["/tmp/first.png "])
        controller.dismissError()
        try await settle { delivered.count == 2 }
        XCTAssertEqual(delivered, ["/tmp/first.png ", "third"])
    }
    func testSystemPasteProvidersPreserveMixedContentAndOrder() async throws {
        let text = NSItemProvider(object: "provider text" as NSString)
        let png = NSItemProvider(item: image.data as NSData, typeIdentifier: UTType.png.identifier)
        let payload = try await NativePastePayload.load([text, png])
        XCTAssertEqual(payload.text, "provider text")
        XCTAssertEqual(payload.files.count, 1)
        XCTAssertEqual(payload.files.first?.data, image.data)
        XCTAssertEqual(payload.files.first?.mime, "image/png")
    }
    func testCancelAsyncProviderReadDiscardsLateClipboardContent() async throws {
        let provider = NSItemProvider()
        var complete: ((Data?, Error?) -> Void)?
        provider.registerDataRepresentation(forTypeIdentifier: UTType.utf8PlainText.identifier, visibility: .all) { completion in
            complete = completion
            return nil
        }
        let controller = NativePasteController()
        var delivered: [String] = []
        controller.configure(agent: "codex", remote: false, available: { true }, upload: { _ in "/tmp/file" }, deliver: { delivered.append($0.value) })
        controller.submit(itemProviders: [provider])
        try await settle { complete != nil }
        controller.cancel()
        complete?(Data("late".utf8), nil)
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(controller.state, .idle)
        XCTAssertTrue(delivered.isEmpty)
    }
    func testImageUploadUsesImageEndpoint() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2))
        let png = renderer.pngData { context in UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2, height: 2)) }
        let path = try await BoardAPI("http://127.0.0.1:4151").upload(png, name: "test.png", mime: "image/png")
        XCTAssertTrue(path.hasPrefix("/tmp/paste-")); XCTAssertTrue(path.hasSuffix(".png"))
        print("NATIVE_IMAGE_UPLOAD_VERIFY path=\(path) sha256=\(SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()) bytes=\(png.count)")
    }
    func testAttachmentReviewRemovesOnlyChosenFileBeforeUpload() async throws {
        let controller = NativePasteController()
        var uploaded: [NativePasteFile] = [], delivered: [NativePasteDelivery] = []
        controller.configure(agent: "codex", remote: false, available: { true }, upload: { file in
            uploaded.append(file); return "/tmp/" + file.name
        }, deliver: { delivered.append($0) })
        controller.submit(.init(text: "review", files: [image, document]), immediately: true)
        XCTAssertEqual(controller.state, .reviewing)
        XCTAssertTrue(uploaded.isEmpty)
        XCTAssertTrue(delivered.isEmpty)
        controller.removeReviewFile(at: 0)
        XCTAssertEqual(controller.reviewFiles, [document])
        XCTAssertEqual(controller.reviewText, "review")
        controller.confirmReview()
        try await settle { controller.state == .idle }
        XCTAssertEqual(uploaded, [document])
        XCTAssertEqual(delivered, [.init(value: "review\n'/tmp/note.txt' ", bracketed: true)])
    }

    func testSnapshotModeKeepsAttachmentReviewButBlocksInsertion() async throws {
        let terminal = TerminalBridge()
        var delivered = 0
        terminal.clipboard.configure(agent: "codex", remote: false, available: { !terminal.readingSnapshot },
            upload: { _ in "/tmp/image.png" }, deliver: { _ in delivered += 1 })
        terminal.clipboard.submit(.init(files: [image]), immediately: true)
        terminal.readingSnapshot = true
        XCTAssertEqual(terminal.clipboard.state, .reviewing)
        XCTAssertEqual(terminal.clipboard.reviewFiles, [image])
        terminal.clipboard.confirmReview()
        guard case .failed = terminal.clipboard.state else { return XCTFail("Frozen terminal must block insertion") }
        XCTAssertEqual(delivered, 0)
        terminal.readingSnapshot = false
        terminal.clipboard.retry()
        try await settle { terminal.clipboard.state == .idle }
        XCTAssertEqual(delivered, 1)
    }

}
