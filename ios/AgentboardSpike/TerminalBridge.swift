import SwiftUI
import WebKit
import Combine

@MainActor
final class TerminalBridge: ObservableObject {
    @Published var connection = "Sample transcript"
    @Published var control = false
    @Published var shift = false
    @Published var fontSize = 13
    @Published var inputFocused = false
    @Published var readingSnapshot = false {
        didSet { if readingSnapshot { inputView?.resetContext() }; updateScrollPermission() }
    }
    @Published var ready = false {
        didSet { if oldValue && !ready { clipboard.cancel(); inputView?.resetContext() }; updateScrollPermission() }
    }
    private var sceneActive = true
    func setSceneActive(_ active: Bool) {
        sceneActive = active
        if !active { shift = false }
        updateScrollPermission()
    }
    var canScroll: Bool { ready && !readingSnapshot && sceneActive }
    private func updateScrollPermission() {
        call("scrollEnabled", ["enabled": canScroll])
    }
    func exitCopyMode() { call("bottom") }
    func insert(_ message: NativePasteDelivery) {
        guard !readingSnapshot else { return }
        inputView?.resetContext()
        // Cancel momentum and emit the insertion in the same WebKit queue as
        // scroll input. A separate native send can overtake queued wheel events.
        call("insert", ["data": message.value, "paste": message.bracketed])
    }
    let clipboard = NativePasteController()
    @Published var liveSession: BoardSession?
    weak var inputView: TerminalInputView?
    weak var webView: WKWebView?

    func call(_ method: String, _ arguments: [String: Any] = [:]) {
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.agentboard?.\(method)(\(json))", completionHandler: nil)
    }
    func send(_ value: String, typing: Bool = false) {
        guard !readingSnapshot else { return }
        if !typing { inputView?.resetContext() }
        let output = NativeTerminalModifiers.applyingShift(to: value, active: shift)
        if shift { shift = false }
        call("send", ["data": output])
    }
    func focus() { if !readingSnapshot { inputView?.becomeFirstResponder() } }
    func hideKeyboard() { shift = false; inputView?.resignFirstResponder() }
    func toggleShift() { shift.toggle() }
    func toggleControl() { inputView?.resetContext(); control.toggle(); call("control", ["active": control]) }
    func paste(_ value: String) { guard !readingSnapshot else { return }; inputView?.resetContext(); call("paste", ["data": value]) }
    func setFont(_ size: Int) { fontSize = size; UserDefaults.standard.set(size, forKey: "terminalFontSize"); call("font", ["size": size]) }
}

struct TerminalWebView: UIViewRepresentable {
    @ObservedObject var bridge: TerminalBridge
    let session: BoardSession
    let endpoint: String
    var live: BoardConnection? = nil
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("terminalFont") private var font = "Menlo, monospace"
    @AppStorage("terminalFontSize") private var size = 13
    @AppStorage("terminalLineHeight") private var lineHeight = 1.3
    @AppStorage("terminalLetterSpacing") private var letterSpacing = 0.0
    @AppStorage("terminalAutocorrect") private var autocorrect = true
    @AppStorage("terminalWebGL") private var webGL = false

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge, session: session, endpoint: endpoint, live: live) }

    func makeUIView(context: Context) -> TerminalContainerView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "terminal")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isInspectable = true
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.focusTerminal))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)
        bridge.webView = view
        if let url = Bundle.main.url(forResource: "terminal", withExtension: "html", subdirectory: "Web") {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        let input = TerminalInputView(terminal: bridge)
        bridge.inputView = input
        return TerminalContainerView(webView: view, input: input)
    }

    func updateUIView(_ view: TerminalContainerView, context: Context) {
        view.input.setAutocorrect(autocorrect)
        context.coordinator.dark = colorScheme == .dark
        bridge.call("theme", ["dark": colorScheme == .dark])
        bridge.call("options", ["fontFamily": font, "fontSize": size, "lineHeight": lineHeight, "letterSpacing": letterSpacing, "webGL": webGL])
    }

    static func dismantleUIView(_ container: TerminalContainerView, coordinator: Coordinator) {
        coordinator.active = false
        coordinator.bridge.clipboard.cancel()
        coordinator.live?.deselect(owner: coordinator.owner)
        coordinator.subscription?.cancel()
        container.input.resignFirstResponder()
        let view = container.webView
        view.evaluateJavaScript("window.agentboard?.dispose()", completionHandler: nil)
        view.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
        view.navigationDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, UIGestureRecognizerDelegate {
        let bridge: TerminalBridge
        let session: BoardSession
        let endpoint: String
        var dark = false
        let live: BoardConnection?
        let owner = UUID()
        var active = true
        var bound = false
        var subscription: AnyCancellable?
        init(bridge: TerminalBridge, session: BoardSession, endpoint: String, live: BoardConnection?) {
            self.bridge = bridge; self.session = session; self.endpoint = endpoint; self.live = live
            super.init()
            bridge.clipboard.configure(agent: session.agent, currentAgent: { [weak bridge] in bridge?.liveSession?.agent ?? session.agent }, remote: session.remote,
                available: { [weak self] in guard let self else { return false }; return self.active && !self.bridge.readingSnapshot && (self.live == nil || self.bridge.ready) },
                upload: { [weak self] file in
                    guard let self, let live = self.live else { throw SessionActionError(message: "Connect to Agentboard to upload files.") }
                    return try await BoardAPI(live.preferences.serverURL).upload(file.data, name: file.name, mime: file.mime)
                }, deliver: { [weak self] message in
                    guard let self, self.active else { return }
                    guard !self.bridge.readingSnapshot else { return }
                    self.bridge.insert(message)
                })
            subscription = live?.$sessions.sink { [weak bridge] sessions in
                bridge?.liveSession = sessions.first { $0.id == session.id }
            }
        }
        @objc func focusTerminal() {
            guard !bridge.readingSnapshot else { return }
            // WebKit takes first responder while finishing its tap. Hand off
            // only after its event has been processed, without a timed delay.
            bridge.webView?.evaluateJavaScript("window.agentboard.prepareInput()") { [weak self] result, _ in
                if result as? Bool == true, let self, self.active, self.live == nil || self.bridge.ready { self.live?.exitCopyMode(); self.bridge.focus() }
            }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            bridge.call("start", ["name": session.name, "endpoint": endpoint, "dark": dark, "native": live != nil])
            let defaults = UserDefaults.standard
            bridge.fontSize = defaults.object(forKey: "terminalFontSize") as? Int ?? 13
            bridge.call("options", ["fontFamily": defaults.string(forKey: "terminalFont") ?? "Menlo, monospace",
                                     "fontSize": bridge.fontSize, "lineHeight": defaults.object(forKey: "terminalLineHeight") as? Double ?? 1.3,
                                     "letterSpacing": defaults.double(forKey: "terminalLetterSpacing"), "webGL": defaults.bool(forKey: "terminalWebGL")])
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            bridge.connection = "Terminal could not load"
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let data = message.body as? [String: Any] else { return }
            if data["type"] as? String == "copy", let text = data["text"] as? String { UIPasteboard.general.string = text }
            if data["type"] as? String == "link", let value = data["url"] as? String, let url = URL(string: value), ["http", "https"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            if let live, active, let type = data["type"] as? String {
                if type == "viewport", let cols = data["cols"] as? Int, let rows = data["rows"] as? Int {
                    let size = TerminalSize(cols: cols, rows: rows)
                    if !bound {
                        bound = true
                        live.select(session.id, owner: owner, size: size,
                                    output: { [weak bridge] value in bridge?.call("write", ["data": value]) },
                                    reset: { [weak bridge] in bridge?.call("reset") },
                                    status: { [weak bridge] state in
                                        bridge?.connection = state.label
                                        bridge?.ready = state == .ready
                                        if state != .ready { bridge?.hideKeyboard() }
                                    })
                    } else { live.resize(size, owner: owner) }
                } else if type == "bottom" {
                    if !bridge.readingSnapshot { live.exitCopyMode() }
                } else if let value = data["data"] as? String, type == "input" || type == "paste" || type == "scroll" {
                    // WebKit cancellation is asynchronous: reject a wheel that
                    // was already queued before readiness or scene state changed.
                    if !bridge.readingSnapshot && (type != "scroll" || bridge.canScroll) {
                        live.input(value, owner: owner, paste: type == "paste", scroll: type == "scroll")
                    }
                }
            }
            if let status = data["status"] as? String { bridge.connection = status }
            if let control = data["control"] as? Bool { bridge.control = control }
        }
    }
}

/// Matches the PWA touch controls. LF avoids tmux treating Shift-Return as submit.
enum NativeTerminalModifiers {
    static func applyingShift(to value: String, active: Bool) -> String {
        guard active else { return value }
        switch value {
        case "\t": return "\u{1b}[Z"
        case "\r": return "\n"
        default: return value
        }
    }
}
