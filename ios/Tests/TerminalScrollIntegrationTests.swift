import XCTest
import SwiftUI
import WebKit
@testable import AgentboardSpike

/// Real bundled xterm page, WK message queue, native clipboard and BoardConnection.
/// The socket records wire order; LiveUITests separately exercises real touch and tmux.
@MainActor final class TerminalScrollIntegrationTests: XCTestCase {
    private final class Socket: BoardSocket {
        var sent: [[String: Any]] = []
        var waiting: CheckedContinuation<String, Error>?
        var queued: [String] = []
        func receive() async throws -> String {
            if !queued.isEmpty { return queued.removeFirst() }
            return try await withCheckedThrowingContinuation { waiting = $0 }
        }
        func emit(_ value: String) {
            if let pending = waiting { waiting = nil; pending.resume(returning: value) }
            else { queued.append(value) }
        }
        func send(_ text: String) async throws {
            let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
            sent.append(value)
            if value["type"] as? String == "terminal-attach" {
                emit(#"{"type":"terminal-ready","sessionId":"scroll"}"#)
            }
        }
        func close() { waiting?.resume(throwing: CancellationError()); waiting = nil }
    }
    private var socket: Socket!
    private var board: BoardConnection!
    private var bridge: TerminalBridge!
    private var coordinator: TerminalWebView.Coordinator!
    private var web: WKWebView!
    private var window: UIWindow!

    override func setUp() async throws {
        board = BoardConnection { [weak self] _ in
            let socket = Socket()
            socket.emit(#"{"type":"sessions","sessions":[{"id":"scroll","name":"Scroll","projectPath":"/tmp","status":"working","source":"managed"}]}"#)
            self?.socket = socket
            return socket
        }
        bridge = TerminalBridge()
        let session = BoardSession(id: "scroll", name: "Scroll", project: "/tmp", agent: "Shell", status: .working, summary: "")
        coordinator = TerminalWebView.Coordinator(bridge: bridge, session: session, endpoint: "", live: board)
        let config = WKWebViewConfiguration()
        config.userContentController.add(coordinator!, name: "terminal")
        web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), configuration: config)
        web.navigationDelegate = coordinator
        bridge.webView = web
        window = UIWindow(frame: web.frame)
        let host = UIViewController(); host.view.addSubview(web)
        window.rootViewController = host; window.makeKeyAndVisible()
        board.configure("http://localhost:4040")
        let url = try XCTUnwrap(Bundle.main.url(forResource: "terminal", withExtension: "html", subdirectory: "Web"))
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        try await until { self.bridge.ready }
        // Drain native readiness -> JS scroll permission before generating touch.
        _ = try await js("true")
    }
    override func tearDown() async throws {
        _ = try? await js("window.agentboard.dispose(); true")
        board?.suspend()
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
        window?.isHidden = true
        web = nil; coordinator = nil; window = nil; bridge = nil; board = nil; socket = nil
    }
    private func js(_ source: String) async throws -> Any { try await web.evaluateJavaScript(source) }
    private func until(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !condition() && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "Native/WebKit condition timed out")
    }
    private var wheels: Int {
        socket.sent.filter { ($0["data"] as? String)?.hasPrefix("\u{1b}[<") == true }.count
    }
    private func flick() async throws {
        let before = wheels
        _ = try await js("""
        window.testTouch = (type, y) => {
            const target = document.getElementById('terminal');
            const touches = type === 'touchend' ? [] : [new Touch({identifier: 1, target, clientX: 100, clientY: y})];
            target.dispatchEvent(new TouchEvent(type, {touches, bubbles: true, cancelable: true}));
        };
        testTouch('touchstart', 100); true
        """)
        try await Task.sleep(for: .milliseconds(30))
        _ = try await js("testTouch('touchmove', 400); testTouch('touchend', 400); true")
        try await until { self.wheels > before }
    }
    private func assertStopped() async throws {
        _ = try await js("true")
        try await Task.sleep(for: .milliseconds(50))
        let stopped = wheels
        try await Task.sleep(for: .milliseconds(350))
        XCTAssertEqual(wheels, stopped, "No wheel input may follow cancellation")
    }

    func testExitCopyModeStopsMomentumBeforeCancelReachesServer() async throws {
        try await flick()
        bridge.exitCopyMode()
        try await until { self.socket.sent.contains { $0["type"] as? String == "tmux-cancel-copy-mode" } }
        try await assertStopped()
        let cancel = try XCTUnwrap(socket.sent.lastIndex { $0["type"] as? String == "tmux-cancel-copy-mode" })
        XCTAssertFalse(socket.sent.dropFirst(cancel + 1).contains { ($0["data"] as? String)?.hasPrefix("\u{1b}[<") == true })
    }
    func testSelectionCancelsMomentumAndDismissalDoesNotResumeIt() async throws {
        try await flick()
        bridge.readingSnapshot = true
        try await assertStopped()
        bridge.readingSnapshot = false
        try await assertStopped()
        try await flick() // A fresh gesture remains usable.
    }
    func testInactiveAndReconnectDoNotResumeOldMomentum() async throws {
        try await flick()
        bridge.setSceneActive(false)
        try await assertStopped()
        bridge.setSceneActive(true)
        try await assertStopped()
        try await flick()
        bridge.ready = false
        try await assertStopped()
        bridge.ready = true
        try await assertStopped()
        try await flick()
    }
    func testInactiveSceneRejectsAlreadyQueuedWebKitWheel() async throws {
        _ = try await js("""
        setTimeout(() => {
            const deadline = performance.now() + 250;
            while (performance.now() < deadline) {}
            window.webkit.messageHandlers.terminal.postMessage({type:'scroll', data:'\\x1b[<64;40;12M'});
        }, 0); true
        """)
        try await Task.sleep(for: .milliseconds(30))
        bridge.setSceneActive(false)
        _ = try await js("true")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(wheels, 0, "A wheel already queued in WebKit must not reach the server after inactivity")
    }

    func testClipboardCannotOvertakeQueuedWebKitScrollOrConsumeControl() async throws {
        // Deliberately occupy WebKit while native clipboard delivery completes.
        // The old direct native send overtook this already-queued wheel message.
        bridge.toggleControl()
        _ = try await js("""
        setTimeout(() => {
            const deadline = performance.now() + 250;
            while (performance.now() < deadline) {}
            window.webkit.messageHandlers.terminal.postMessage({type:'scroll', data:'\\x1b[<64;40;12M'});
        }, 0); true
        """)
        try await Task.sleep(for: .milliseconds(30))
        bridge.clipboard.submit(.init(text: "clipboard-verbatim", files: []), immediately: true)
        try await until { self.socket.sent.contains { $0["data"] as? String == "clipboard-verbatim" } }
        try await Task.sleep(for: .milliseconds(350))
        let relevant = socket.sent.filter { ["terminal-input", "terminal-paste", "tmux-cancel-copy-mode"].contains($0["type"] as? String ?? "") }
        XCTAssertEqual(relevant.map { $0["type"] as? String }, ["terminal-input", "tmux-cancel-copy-mode", "terminal-paste"])
        XCTAssertEqual(relevant.last?["data"] as? String, "clipboard-verbatim")
        XCTAssertTrue(bridge.control, "Clipboard bytes must not consume keyboard modifiers")
    }
}
